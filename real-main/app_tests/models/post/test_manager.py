import base64
from io import BytesIO
from os import path

import pendulum
import pytest

from app.models.media.enums import MediaStatus
from app.models.post.enums import PostStatus, PostType

grant_path = path.join(path.dirname(__file__), '..', '..', 'fixtures', 'grant.jpg')


@pytest.fixture
def user(user_manager):
    yield user_manager.create_cognito_only_user('pbuid', 'pbUname')


@pytest.fixture
def posts(post_manager, user):
    post1 = post_manager.add_post(user.id, 'pid1', PostType.TEXT_ONLY, text='t')
    post2 = post_manager.add_post(user.id, 'pid2', PostType.TEXT_ONLY, text='t')
    yield (post1, post2)


@pytest.fixture
def album(album_manager, user):
    yield album_manager.add_album(user.id, 'aid', 'album name')


def test_parse_s3_path(post_manager):
    assert post_manager.parse_s3_path('') is None
    assert post_manager.parse_s3_path('aslkdfj') is None
    assert post_manager.parse_s3_path('user-id/post') is None
    assert post_manager.parse_s3_path('usER-id/post/poST-id/') is None
    assert post_manager.parse_s3_path('usER-id/post/poST-id/media/medIA-id') is None
    assert post_manager.parse_s3_path('usER-id/post/poST-id/media/medIA-id/480p.jpg') is None
    assert post_manager.parse_s3_path('usER-id/post/poST-id/media/medIA-id/.jpg') is None
    assert post_manager.parse_s3_path('usER-id/post/poST-id/media/medIA-id/native') is None

    elems = post_manager.parse_s3_path('usER-id/post/poST-id/media/medIA-id/native.jpg')
    assert elems == {'user_id': 'usER-id', 'post_id': 'poST-id', 'media_id': 'medIA-id'}

    # rejected for now
    assert post_manager.parse_s3_path('usER-id/post/poST-id/image/native.jpg') is None


def test_get_post(post_manager, user_manager):
    # create a post behind the scenes
    post_id = 'pid'
    user = user_manager.create_cognito_only_user('pbuid', 'pbUname')
    post_manager.add_post(user.id, post_id, PostType.TEXT_ONLY, text='t')

    post = post_manager.get_post(post_id)
    assert post.id == post_id


def test_get_post_dne(post_manager):
    assert post_manager.get_post('pid-dne') is None


def test_add_post_errors(post_manager):
    # try to add a post without any content (no text or media)
    with pytest.raises(post_manager.exceptions.PostException, match='without text or media'):
        post_manager.add_post('pbuid', 'pid', PostType.TEXT_ONLY)

    # try to add a post without two media
    media_uploads = [{'mediaId': 'mid1'}, {'mediaId': 'mid2'}]
    with pytest.raises(post_manager.exceptions.PostException, match='more than one media'):
        post_manager.add_post('pbuid', 'pid', PostType.IMAGE, media_uploads=media_uploads)

    # try to add a post with a negative lifetime value
    lifetime_duration = pendulum.duration(hours=-1)
    with pytest.raises(post_manager.exceptions.PostException, match='negative lifetime'):
        post_manager.add_post('pbuid', 'pid', PostType.TEXT_ONLY, text='t', lifetime_duration=lifetime_duration)

    # try to add a post with a zero lifetime value
    lifetime_duration = pendulum.duration(hours=0)
    with pytest.raises(post_manager.exceptions.PostException, match='negative lifetime'):
        post_manager.add_post('pbuid', 'pid', PostType.TEXT_ONLY, text='t', lifetime_duration=lifetime_duration)

    # try to add an image post with no media_uploads
    with pytest.raises(post_manager.exceptions.PostException, match='mediaObjectUploads must be supplied'):
        post_manager.add_post('pbuid', 'pid', PostType.IMAGE, text='my text')

    # try to add a text-only post with a media_upload
    with pytest.raises(post_manager.exceptions.PostException, match='mediaObjectUploads may not be supplied'):
        post_manager.add_post('pbuid', 'pid', PostType.TEXT_ONLY, media_uploads=[{'mediaId': 'mid'}])

    # try to add an invalid post type
    with pytest.raises(post_manager.exceptions.PostException, match='Invalid postType'):
        post_manager.add_post('pbuid', 'pid', 'ptype')


def test_add_text_only_post(post_manager, user_manager):
    user_id = 'pbuid'
    post_id = 'pid'
    text = 'lore ipsum'
    now = pendulum.now('utc')

    # add the post
    user_manager.create_cognito_only_user(user_id, 'pbUname')
    post_manager.add_post(user_id, post_id, PostType.TEXT_ONLY, text=text, now=now)

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert post.item['postedByUserId'] == user_id
    assert post.item['postedAt'] == now.to_iso8601_string()
    assert post.item['text'] == 'lore ipsum'
    assert post.item['textTags'] == []
    assert post.item['postStatus'] == PostStatus.COMPLETED
    assert 'expiresAt' not in post.item
    assert list(post_manager.media_manager.dynamo.generate_by_post(post_id)) == []


def test_add_text_with_tags_post(post_manager, user_manager):
    user_id = 'pbuid'
    username = 'pbUname'
    post_id = 'pid'
    text = 'Tagging you @pbUname!'

    # add the post
    user_manager.create_cognito_only_user(user_id, username)
    post_manager.add_post(user_id, post_id, PostType.TEXT_ONLY, text=text)

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert post.item['text'] == text
    assert post.item['textTags'] == [{'tag': '@pbUname', 'userId': 'pbuid'}]


def test_add_post_album_errors(user_manager, post_manager, user, album):
    # can't create post with album that doesn't exist
    with pytest.raises(post_manager.exceptions.PostException, match='does not exist'):
        post_manager.add_post(user.id, 'pid-42', PostType.IMAGE, media_uploads=[{'mediaId': 'm'}], album_id='aid-dne')

    # can't create post in somebody else's album
    user2 = user_manager.create_cognito_only_user('uid-2', 'uname2')
    with pytest.raises(post_manager.exceptions.PostException, match='does not belong to'):
        post_manager.add_post(user2.id, 'pid-42', PostType.IMAGE, media_uploads=[{'mediaId': 'm'}], album_id=album.id)

    # verify we can add without error
    post_manager.add_post(user.id, 'pid-42', PostType.IMAGE, media_uploads=[{'mediaId': 'mid'}], album_id=album.id)


def test_add_text_only_post_to_album(post_manager, user, album):
    post_id = 'pid'

    # add the post, check all looks good
    post = post_manager.add_post(user.id, post_id, PostType.TEXT_ONLY, text='t', album_id=album.id)
    assert post.id == post_id
    assert post.item['albumId'] == album.id
    assert post.item['gsiK3SortKey'] == 0   # album rank

    post.refresh_item()
    assert post.item['albumId'] == album.id
    assert post.item['gsiK3SortKey'] == 0   # album rank

    album.refresh_item()
    assert album.item['postCount'] == 1
    assert album.item['rankCount'] == 1


def test_add_media_post(post_manager):
    user_id = 'pbuid'
    post_id = 'pid'
    now = pendulum.now('utc')
    media_id = 'mid'
    media_upload = {'mediaId': media_id}

    # add the post (& media)
    post_manager.add_post(user_id, post_id, PostType.IMAGE, now=now, media_uploads=[media_upload])

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert post.item['postedByUserId'] == user_id
    assert post.item['postedAt'] == now.to_iso8601_string()
    assert post.item['postStatus'] == PostStatus.PENDING
    assert 'text' not in post.item
    assert 'textTags' not in post.item
    assert 'expiresAt' not in post.item

    media_items = list(post_manager.media_manager.dynamo.generate_by_post(post_id))
    assert len(media_items) == 1
    assert media_items[0]['mediaId'] == media_id
    assert media_items[0]['mediaType'] == 'IMAGE'
    assert media_items[0]['postedAt'] == now.to_iso8601_string()
    assert media_items[0]['mediaStatus'] == MediaStatus.AWAITING_UPLOAD
    assert 'expiresAt' not in media_items[0]


def test_add_media_post_text_empty_string(post_manager):
    user_id = 'pbuid'
    post_id = 'pid'
    now = pendulum.now('utc')
    media_id = 'mid'
    media_upload = {'mediaId': media_id}

    # add the post (& media)
    post_manager.add_post(user_id, post_id, PostType.IMAGE, now=now, media_uploads=[media_upload], text='')

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert 'text' not in post.item
    assert 'textTags' not in post.item


def test_add_media_post_with_image_data(user, post_manager, requests_mock, post_verification_api_creds):
    post_id = 'pid'
    now = pendulum.now('utc')
    media_id = 'mid'

    image_data_b64 = BytesIO()
    with open(grant_path, 'rb') as fh:
        base64.encode(fh, image_data_b64)
    image_data_b64.seek(0)
    media_upload = {'mediaId': media_id, 'imageData': image_data_b64.read()}

    # mock out the response from the post verification api
    post_manager.clients['cloudfront'].configure_mock(**{
        'generate_presigned_url.return_value': 'https://a-url.com',
    })
    resp_json = {
        'errors': [],
        'data': {
            'isVerified': True,
        }
    }
    api_url = post_verification_api_creds['root'] + 'verify/image'
    requests_mock.post(api_url, json=resp_json)

    # add the post (& media)
    post_manager.add_post(user.id, post_id, PostType.IMAGE, now=now, media_uploads=[media_upload])

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert post.item['postedByUserId'] == user.id
    assert post.item['postedAt'] == now.to_iso8601_string()
    assert post.item['postStatus'] == PostStatus.COMPLETED
    assert 'text' not in post.item
    assert 'textTags' not in post.item
    assert 'expiresAt' not in post.item

    media_items = list(post_manager.media_manager.dynamo.generate_by_post(post_id))
    assert len(media_items) == 1
    assert media_items[0]['mediaId'] == media_id
    assert media_items[0]['mediaType'] == 'IMAGE'
    assert media_items[0]['postedAt'] == now.to_iso8601_string()
    assert media_items[0]['mediaStatus'] == MediaStatus.UPLOADED
    assert 'expiresAt' not in media_items[0]


def test_add_media_post_with_options(post_manager, album):
    user_id = 'pbuid'
    post_id = 'pid'
    text = 'lore ipsum'
    now = pendulum.now('utc')
    media_id = 'mid'
    media_upload = {
        'mediaId': media_id,
        'takenInReal': False,
        'originalFormat': 'org-format',
    }
    lifetime_duration = pendulum.duration(hours=1)

    # add the post (& media)
    post_manager.add_post(
        user_id, post_id, PostType.IMAGE, text=text, now=now, media_uploads=[media_upload],
        lifetime_duration=lifetime_duration, album_id=album.id, comments_disabled=False, likes_disabled=True,
        verification_hidden=False,
    )
    expires_at = now + lifetime_duration

    # retrieve the post & media, check it
    post = post_manager.get_post(post_id)
    assert post.id == post_id
    assert post.item['postedByUserId'] == user_id
    assert post.item['albumId'] == album.id
    assert post.item['postedAt'] == now.to_iso8601_string()
    assert post.item['text'] == 'lore ipsum'
    assert post.item['postStatus'] == PostStatus.PENDING
    assert post.item['expiresAt'] == expires_at.to_iso8601_string()
    assert post.item['commentsDisabled'] is False
    assert post.item['likesDisabled'] is True
    assert post.item['verificationHidden'] is False

    media_items = list(post_manager.media_manager.dynamo.generate_by_post(post_id))
    assert len(media_items) == 1
    assert media_items[0]['mediaId'] == media_id
    assert media_items[0]['mediaType'] == 'IMAGE'
    assert media_items[0]['postedAt'] == now.to_iso8601_string()
    assert media_items[0]['mediaStatus'] == MediaStatus.AWAITING_UPLOAD
    assert media_items[0]['takenInReal'] is False
    assert media_items[0]['originalFormat'] == 'org-format'


def test_delete_recently_expired_posts(post_manager, user_manager, caplog):
    user = user_manager.create_cognito_only_user('pbuid', 'pbUname')
    now = pendulum.now('utc')

    # create four posts with diff. expiration qualities
    post_no_expires = post_manager.add_post(user.id, 'pid1', PostType.TEXT_ONLY, text='t')
    assert 'expiresAt' not in post_no_expires.item

    post_future_expires = post_manager.add_post(
        user.id, 'pid2', PostType.TEXT_ONLY, text='t', lifetime_duration=pendulum.duration(hours=1)
    )
    assert post_future_expires.item['expiresAt'] > now.to_iso8601_string()

    lifetime_duration = pendulum.duration(hours=now.hour, minutes=now.minute)
    post_expired_today = post_manager.add_post(
        user.id, 'pid3', PostType.TEXT_ONLY, text='t', lifetime_duration=lifetime_duration,
        now=(now - lifetime_duration),
    )
    assert post_expired_today.item['expiresAt'] == now.to_iso8601_string()

    post_expired_last_week = post_manager.add_post(
        user.id, 'pid4', PostType.TEXT_ONLY, text='t', lifetime_duration=pendulum.duration(hours=1),
        now=(now - pendulum.duration(days=7)),
    )
    assert post_expired_last_week.item['expiresAt'] < (now - pendulum.duration(days=6)).to_iso8601_string()

    # run the deletion run
    post_manager.delete_recently_expired_posts()

    # check we logged one delete
    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == 'WARNING'
    assert 'Deleting' in caplog.records[0].msg
    assert post_expired_today.id in caplog.records[0].msg

    # check one of the posts is missing from the DB, but the rest are still there
    assert post_no_expires.refresh_item().item
    assert post_future_expires.refresh_item().item
    assert post_expired_today.refresh_item().item is None
    assert post_expired_last_week.refresh_item().item


def test_delete_older_expired_posts(post_manager, user_manager, caplog):
    user = user_manager.create_cognito_only_user('pbuid', 'pbUname')
    now = pendulum.now('utc')

    # create four posts with diff. expiration qualities
    post_no_expires = post_manager.add_post(user.id, 'pid1', PostType.TEXT_ONLY, text='t')
    assert 'expiresAt' not in post_no_expires.item

    post_future_expires = post_manager.add_post(
        user.id, 'pid2', PostType.TEXT_ONLY, text='t', lifetime_duration=pendulum.duration(hours=1),
    )
    assert post_future_expires.item['expiresAt'] > now.to_iso8601_string()

    lifetime_duration = pendulum.duration(hours=now.hour, minutes=now.minute)
    post_expired_today = post_manager.add_post(
        user.id, 'pid3', PostType.TEXT_ONLY, text='t', lifetime_duration=lifetime_duration,
        now=(now - lifetime_duration),
    )
    assert post_expired_today.item['expiresAt'] == now.to_iso8601_string()

    post_expired_last_week = post_manager.add_post(
        user.id, 'pid4', PostType.TEXT_ONLY, text='t', lifetime_duration=pendulum.duration(hours=1),
        now=(now - pendulum.duration(days=7)),
    )
    assert post_expired_last_week.item['expiresAt'] < (now - pendulum.duration(days=6)).to_iso8601_string()

    # run the deletion run
    post_manager.delete_older_expired_posts()

    # check we logged one delete
    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == 'WARNING'
    assert 'Deleting' in caplog.records[0].msg
    assert post_expired_last_week.id in caplog.records[0].msg

    # check one of the posts is missing from the DB, but the rest are still there
    assert post_no_expires.refresh_item().item
    assert post_future_expires.refresh_item().item
    assert post_expired_today.refresh_item().item
    assert post_expired_last_week.refresh_item().item is None


def test_set_post_status_to_error(post_manager, user_manager):
    user = user_manager.create_cognito_only_user('pbuid', 'pbUname')

    # create a COMPLETED post, verify cannot transition it to ERROR
    post = post_manager.add_post(user.id, 'pid1', PostType.TEXT_ONLY, text='t')
    with pytest.raises(post_manager.exceptions.PostException, match='PENDING'):
        post.error()

    # add a PENDING post, transition it to ERROR, verify all good
    media_uploads = [{'mediaId': 'mid1'}]
    post = post_manager.add_post('pbuid', 'pid', PostType.IMAGE, media_uploads=media_uploads)
    post.error()
    assert post.item['postStatus'] == PostStatus.ERROR
    post.refresh_item()
    assert post.item['postStatus'] == PostStatus.ERROR
