/* eslint-env jest */

const uuidv4 = require('uuid/v4')
// the aws-appsync-subscription-link pacakge expects WebSocket to be globaly defined, like in the browser
global.WebSocket = require('ws')

const cognito = require('../../utils/cognito')
const misc = require('../../utils/misc')
const {mutations, subscriptions} = require('../../schema')

const loginCache = new cognito.AppSyncLoginCache()

beforeAll(async () => {
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
})

beforeEach(async () => await loginCache.clean())
afterAll(async () => await loginCache.reset())

test('Card message triggers cannot be called from external graphql client', async () => {
  const {client: ourClient, userId: ourUserId} = await loginCache.getCleanLogin()

  // verify we can't call the trigger method, even with well-formed input
  await expect(
    ourClient.mutate({
      mutation: mutations.triggerCardNotification,
      variables: {
        input: {
          userId: ourUserId,
          type: 'ADDED',
          cardId: uuidv4(),
          title: 'title',
          action: 'https://real.app/go',
        },
      },
    }),
  ).rejects.toThrow(/ClientError: Access denied/)
})

test('Cannot subscribe to other users notifications', async () => {
  const {client: ourClient} = await loginCache.getCleanLogin()
  const {client: theirClient, userId: theirUserId} = await loginCache.getCleanLogin()

  // we both try to subscribe to their messages
  // Note: there doesn't seem to be any error thrown at the time of subscription, it's just that
  // the subscription next() method is never triggered
  const ourNotifications = []
  const theirNotifications = []
  await ourClient
    .subscribe({query: subscriptions.onCardNotification, variables: {userId: theirUserId}})
    .subscribe({
      next: (resp) => ourNotifications.push(resp),
      error: (resp) => console.log(resp),
    })
  const theirSub = await theirClient
    .subscribe({query: subscriptions.onCardNotification, variables: {userId: theirUserId}})
    .subscribe({
      next: (resp) => theirNotifications.push(resp),
      error: (resp) => console.log(resp),
    })
  const theirSubInitTimeout = misc.sleep(15000) // https://github.com/awslabs/aws-mobile-appsync-sdk-js/issues/541
  await misc.sleep(2000) // let the subscription initialize

  // they create a post
  const postId = uuidv4()
  await theirClient
    .mutate({
      mutation: mutations.addPost,
      variables: {postId, postType: 'TEXT_ONLY', text: 'lore ipsum'},
    })
    .then(({data}) => {
      expect(data.addPost.postId).toBe(postId)
      expect(data.addPost.postStatus).toBe('COMPLETED')
    })

  // we comment on their post (thus generating a card)
  await ourClient
    .mutate({mutation: mutations.addComment, variables: {commentId: uuidv4(), postId, text: 'lore!'}})
    .then(({data}) => expect(data.addComment.commentId).toBeTruthy())

  // wait for some messages to show up, ensure none did for us but one did for them
  await misc.sleep(5000)
  expect(ourNotifications).toHaveLength(0)
  expect(theirNotifications).toHaveLength(1)

  // we don't unsubscribe from our subscription because
  //  - it's not actually active, although I have yet to find a way to expect() that
  //  - unsubcribing results in the AWS SDK throwing errors
  // shut down the subscription
  theirSub.unsubscribe()
  await theirSubInitTimeout
})
