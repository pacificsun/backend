import logging

import pendulum

logger = logging.getLogger()


class CommentPostProcessor:
    def __init__(self, dynamo=None, post_manager=None, user_manager=None):
        self.dynamo = dynamo
        self.post_manager = post_manager
        self.user_manager = user_manager

    def run(self, pk, sk, old_item, new_item):
        comment_id = pk.split('/')[1]

        # comment added, edited or deleted
        if sk == '-':
            post_id = (new_item or old_item)['postId']
            user_id = (new_item or old_item)['userId']
            created_at = pendulum.parse((new_item or old_item)['commentedAt'])
            if not old_item and new_item:  # comment added?
                self.post_manager.postprocessor.comment_added(post_id, user_id, created_at)
                self.user_manager.postprocessor.comment_added(user_id)
            if old_item and not new_item:  # comment deleted?
                self.post_manager.postprocessor.comment_deleted(post_id, comment_id, user_id, created_at)
                self.user_manager.postprocessor.comment_deleted(user_id)

        # comment view added
        if sk.startswith('view/') and not old_item and new_item:
            user_id = sk.split('/')[1]
            comment_item = self.dynamo.get_comment(comment_id)
            self.post_manager.postprocessor.comment_view_added(comment_item['postId'], user_id)