import logging
import os

from app.utils import image_size
from app.models.post.enums import PostStatus, PostType

from . import enums, exceptions
from .enums import UserPrivacyStatus
from .dynamo import UserDynamo
from .validate import UserValidate

logger = logging.getLogger()

PLACEHOLDER_PHOTOS_DIRECTORY = os.environ.get('PLACEHOLDER_PHOTOS_DIRECTORY')
FRONTEND_RESOURCES_DOMAIN = os.environ.get('FRONTEND_RESOURCES_DOMAIN')

# annoying this needs to exist
CONTACT_ATTRIBUTE_NAMES = {
    'email': {
        'short': 'email',
        'cognito': 'email',
        'dynamo': 'email',
    },
    'phone': {
        'short': 'phone',
        'cognito': 'phone_number',
        'dynamo': 'phoneNumber',
    },
}


class User:

    enums = enums
    exceptions = exceptions
    client_names = ['cloudfront', 'cognito', 'dynamo', 's3_uploads']

    def __init__(self, user_item, clients, block_manager=None, follow_manager=None, trending_manager=None,
                 post_manager=None, placeholder_photos_directory=PLACEHOLDER_PHOTOS_DIRECTORY,
                 frontend_resources_domain=FRONTEND_RESOURCES_DOMAIN):
        self.clients = clients
        for client_name in self.client_names:
            if client_name in clients:
                setattr(self, f'{client_name}_client', clients[client_name])
        if 'dynamo' in clients:
            self.dynamo = UserDynamo(clients['dynamo'])
        if block_manager:
            self.block_manager = block_manager
        if follow_manager:
            self.follow_manager = follow_manager
        if post_manager:
            self.post_manager = post_manager
        if trending_manager:
            self.trending_manager = trending_manager
        self.validate = UserValidate()
        self.item = user_item
        self.id = user_item['userId']
        self.placeholder_photos_directory = placeholder_photos_directory
        self.frontend_resources_domain = frontend_resources_domain

    @property
    def username(self):
        return self.item['username']

    def get_photo_path(self, size, photo_post_id=None):
        photo_post_id = photo_post_id or self.item.get('photoPostId')
        if not photo_post_id:
            return None
        return '/'.join([self.id, 'profile-photo', photo_post_id, size.filename])

    def get_placeholder_photo_path(self, size):
        code = self.item.get('placeholderPhotoCode')
        if not code or not self.placeholder_photos_directory:
            return None
        return '/'.join([self.placeholder_photos_directory, code, size.filename])

    def get_photo_url(self, size):
        photo_path = self.get_photo_path(size)
        if photo_path:
            return self.cloudfront_client.generate_presigned_url(photo_path, ['GET', 'HEAD'])
        placeholder_path = self.get_placeholder_photo_path(size)
        if placeholder_path and self.frontend_resources_domain:
            return f'https://{self.frontend_resources_domain}/{placeholder_path}'
        return None

    def refresh_item(self):
        self.item = self.dynamo.get_user(self.id)
        return self

    def serialize(self, caller_user_id):
        resp = self.item.copy()
        resp['blockerStatus'] = self.block_manager.get_block_status(self.id, caller_user_id)
        resp['followedStatus'] = self.follow_manager.get_follow_status(caller_user_id, self.id)
        return resp

    def set_accepted_eula_version(self, version):
        if version == self.item.get('acceptedEULAVersion'):
            return self
        self.item = self.dynamo.set_user_accepted_eula_version(self.id, version)
        return self

    def set_privacy_status(self, privacy_status):
        old_privacy_status = self.item.get('privacyStatus')
        if privacy_status == old_privacy_status:
            return self

        # are we changing from private to public?
        if old_privacy_status == UserPrivacyStatus.PRIVATE and privacy_status == UserPrivacyStatus.PUBLIC:
            self.follow_manager.accept_all_requested_follow_requests(self.id)
            self.follow_manager.delete_all_denied_follow_requests(self.id)

        self.item = self.dynamo.set_user_privacy_status(self.id, privacy_status)
        return self

    def update_username(self, username):
        old_username = self.item['username']
        if old_username == username:
            # no change was requested
            return self

        # validate and claim the lowercased username in cognito
        self.validate.username(username)
        try:
            self.cognito_client.set_user_attributes(self.id, {'preferred_username': username.lower()})
        except self.cognito_client.boto_client.exceptions.AliasExistsException:
            raise exceptions.UserValidationException(f'Username `{username}` already taken (case-insensitive cmp)')

        self.item = self.dynamo.update_user_username(self.id, username, old_username)
        return self

    def update_photo(self, post_id):
        "Update photo. Set post_id=None to go back to the default profile pics"

        old_post_id = self.item.get('photoPostId')
        if post_id == old_post_id:
            return self

        if post_id:
            post = self.post_manager.get_post(post_id)
            if not post:
                raise exceptions.UserException(f'Post `{post_id}` not found')
            if post.type != PostType.IMAGE:
                raise exceptions.UserException(f'Post `{post_id}` does not have type `{PostType.IMAGE}`')
            if post.status != PostStatus.COMPLETED:
                raise exceptions.UserException(f'Post `{post_id}` does not have status `{PostStatus.COMPLETED}`')
            if post.user_id != self.id:
                raise exceptions.UserException(f'Post `{post_id}` does not belong to this user')
            if post.media.item.get('isVerified') is not True:
                raise exceptions.UserException(f'Post `{post_id}` is not verified')

            # add the new s3 objects
            self.add_photo_s3_objects(post)

        # then dynamo
        self.item = self.dynamo.set_user_photo_post_id(self.id, post_id)

        # Leave the old images around as their may be existing urls out there that point to them
        # Could schedule a job to delete them a hour from now
        return self

    def add_photo_s3_objects(self, post):
        assert post.type == post.enums.PostType.IMAGE
        for size in image_size.JPEGS:
            source_path = post.get_s3_image_path(size)
            dest_path = self.get_photo_path(size, photo_post_id=post.id)
            self.s3_uploads_client.copy_object(source_path, dest_path)

    def update_details(self, full_name=None, bio=None, language_code=None, theme_code=None,
                       follow_counts_hidden=None, view_counts_hidden=None, comments_disabled=None,
                       likes_disabled=None, sharing_disabled=None, verification_hidden=None):
        "To delete a detail, set it to the empty string. Ex: `full_name=''`"
        kwargs = {}

        if full_name is not None and full_name != self.item.get('fullName'):
            kwargs['full_name'] = full_name

        if bio is not None and bio != self.item.get('bio'):
            kwargs['bio'] = bio

        if language_code is not None and language_code != self.item.get('languageCode', 'en'):
            kwargs['language_code'] = language_code

        if theme_code is not None and theme_code != self.item.get('themeCode', 'black.green'):
            kwargs['theme_code'] = theme_code

        if follow_counts_hidden is not None and follow_counts_hidden != self.item.get('followCountsHidden', False):
            kwargs['follow_counts_hidden'] = follow_counts_hidden

        if view_counts_hidden is not None and view_counts_hidden != self.item.get('viewCountsHidden', False):
            kwargs['view_counts_hidden'] = view_counts_hidden

        if comments_disabled is not None and comments_disabled != self.item.get('commentsDisabled', False):
            kwargs['comments_disabled'] = comments_disabled

        if likes_disabled is not None and likes_disabled != self.item.get('likesDisabled', False):
            kwargs['likes_disabled'] = likes_disabled

        if sharing_disabled is not None and sharing_disabled != self.item.get('sharingDisabled', False):
            kwargs['sharing_disabled'] = sharing_disabled

        if verification_hidden is not None and verification_hidden != self.item.get('verificationHidden', False):
            kwargs['verification_hidden'] = verification_hidden

        if kwargs:
            self.item = self.dynamo.set_user_details(self.id, **kwargs)
        return self

    def clear_photo_s3_objects(self):
        photo_dir_prefix = '/'.join([self.id, 'profile-photo', ''])
        self.s3_uploads_client.delete_objects_with_prefix(photo_dir_prefix)

    def delete(self):
        """
        Delete the user item and resources it directly owns (ie profile photo) from stateful services.
        Return the dynamo item as it was before the delete.
        """
        # remove our trending item, if it's there
        self.trending_manager.dynamo.delete_trending(self.id)

        # delete current and old profile photos
        self.clear_photo_s3_objects()

        # release our preferred_username from cognito
        try:
            self.cognito_client.clear_user_attribute(self.id, 'preferred_username')
        except self.cognito_client.boto_client.exceptions.UserNotFoundException:
            logger.warning(f'No cognito user pool entry found when deleting user `{self.id}`')

        # delete our own profile
        item = self.dynamo.delete_user(self.id)
        self.item = None
        self.id = None
        return item

    def start_change_contact_attribute(self, attribute_name, attribute_value):
        assert attribute_name in CONTACT_ATTRIBUTE_NAMES
        names = CONTACT_ATTRIBUTE_NAMES[attribute_name]

        # verify we actually need to do anything
        old_value = self.item.get(names['dynamo'])
        if old_value == attribute_value:
            raise exceptions.UserVerificationException(f'User {attribute_name} already set to `{attribute_value}`')

        # first we set the users email to the new, unverified one, while also setting it to another property
        # this sends the verification email to the user
        attrs = {
            names['cognito']: attribute_value,
            f'custom:unverified_{names["short"]}': attribute_value,
        }
        self.cognito_client.set_user_attributes(self.id, attrs)

        # then if we have a verified version for the user stored in dynamo, set their main property in
        # cognito *back* to their verified version. This allows them to still use it to login.
        if old_value:
            attrs = {
                names['cognito']: old_value,
                f'{names["cognito"]}_verified': 'true',
            }
            self.cognito_client.set_user_attributes(self.id, attrs)
        return self

    def finish_change_contact_attribute(self, attribute_name, access_token, verification_code):
        assert attribute_name in CONTACT_ATTRIBUTE_NAMES
        names = CONTACT_ATTRIBUTE_NAMES[attribute_name]

        # first, figure out what that the value we're validating is
        user_attrs = self.cognito_client.get_user_attributes(self.id)
        value = user_attrs.get(f'custom:unverified_{names["short"]}')
        if not value:
            raise exceptions.UserVerificationException(f'No unverified email found to validate for user `{self.id}`')

        # try to do the validation
        try:
            self.cognito_client.verify_user_attribute(access_token, names['cognito'], verification_code)
        except self.cognito_client.boto_client.exceptions.CodeMismatchException:
            raise exceptions.UserVerificationException('Verification code is invalid')

        # success, update cognito, dynamo, then delete the temporary attribute in cognito
        attrs = {
            names['cognito']: value,
            f'{names["cognito"]}_verified': 'true',
        }
        self.cognito_client.set_user_attributes(self.id, attrs)
        self.item = self.dynamo.set_user_details(self.id, **{names['short']: value})
        self.cognito_client.clear_user_attribute(self.id, f'custom:unverified_{names["short"]}')
        return self
