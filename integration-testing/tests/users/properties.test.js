/* eslint-env jest */
const path = require('path')
const uuidv4 = require('uuid/v4')

const cognito = require('../../utils/cognito.js')
const misc = require('../../utils/misc.js')
const schema = require('../../utils/schema.js')

const grantPath = path.join(__dirname, '..', '..', 'fixtures', 'grant.jpg')
const grantContentType = 'image/jpeg'

const loginCache = new cognito.AppSyncLoginCache()

beforeAll(async () => {
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
})

beforeEach(async () => await loginCache.clean())
afterAll(async () => await loginCache.clean())


describe('Read and write properties our our own profile', () => {

  // username is tested in the set-username.test.js

  test('followed/follwer status', async () => {
    const [ourClient, ourUserId] = await loginCache.getCleanLogin()
    let resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['followedStatus']).toBe('SELF')
    expect(resp['data']['user']['followerStatus']).toBe('SELF')
  })

  test('privacyStatus', async () => {
    const [ourClient, ourUserId] = await loginCache.getCleanLogin()
    let resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['privacyStatus']).toBe('PUBLIC')

    resp = await ourClient.mutate({mutation: schema.setUserPrivacyStatus, variables: {privacyStatus: 'PRIVATE'}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['setUserDetails']['privacyStatus']).toBe('PRIVATE')

    resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['privacyStatus']).toBe('PRIVATE')

    resp = await ourClient.mutate({mutation: schema.setUserPrivacyStatus, variables: {privacyStatus: 'PUBLIC'}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['setUserDetails']['privacyStatus']).toBe('PUBLIC')

    resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['privacyStatus']).toBe('PUBLIC')
  })

  test('fullName and bio', async () => {
    const bio = 'truckin\''
    const fullName = 'Hunter S.'
    const [ourClient, ourUserId] = await loginCache.getCleanLogin()

    let resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['bio']).toBeNull()
    expect(resp['data']['user']['fullName']).toBeNull()

    // set to some custom values
    resp = await ourClient.mutate({mutation: schema.setUserDetails, variables: {bio, fullName}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['setUserDetails']['bio']).toBe(bio)
    expect(resp['data']['setUserDetails']['fullName']).toBe(fullName)

    resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['bio']).toBe(bio)
    expect(resp['data']['user']['fullName']).toBe(fullName)

    // clear out the custom values
    resp = await ourClient.mutate({mutation: schema.setUserDetails, variables: {bio: '', fullName: ''}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['setUserDetails']['bio']).toBeNull()
    expect(resp['data']['setUserDetails']['fullName']).toBeNull()

    resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
    expect(resp['errors']).toBeUndefined()
    expect(resp['data']['user']['bio']).toBeNull()
    expect(resp['data']['user']['fullName']).toBeNull()
  })
})


test('setUserDetails without any arguments returns an error', async () => {
  const [ourClient] = await loginCache.getCleanLogin()
  await expect(ourClient.mutate({mutation: schema.setUserDetails})).rejects.toBeDefined()
})


test('Try to get user that does not exist', async () => {
  const [ourClient] = await loginCache.getCleanLogin()
  const userId = uuidv4()

  let resp = await ourClient.query({query: schema.user, variables: {userId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']).toBeNull()
})


test('Set and delete our profile photo', async () => {
  const [ourClient] = await loginCache.getCleanLogin()

  // check that it's not already set
  let resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['photoUrl']).toBeNull()
  expect(resp['data']['self']['photoUrl64p']).toBeNull()
  expect(resp['data']['self']['photoUrl480p']).toBeNull()
  expect(resp['data']['self']['photoUrl1080p']).toBeNull()
  expect(resp['data']['self']['photoUrl4k']).toBeNull()

  // create a post with an image
  const postId = uuidv4()
  const mediaId = uuidv4()
  resp = await ourClient.mutate({mutation: schema.addOneMediaPost, variables: {postId, mediaId, mediaType: 'IMAGE'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['addPost']['postStatus']).toBe('PENDING')
  expect(resp['data']['addPost']['mediaObjects'][0]['mediaStatus']).toBe('AWAITING_UPLOAD')

  // upload the image, give the s3 trigger a second to fire
  const uploadUrl = resp['data']['addPost']['mediaObjects'][0]['uploadUrl']
  await misc.uploadMedia(grantPath, grantContentType, uploadUrl)
  await misc.sleep(3000)

  // get our uploaded/completed media, we should have just that one media object
  resp = await ourClient.query({query: schema.getMediaObjects})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['getMediaObjects']['items']).toHaveLength(1)
  expect(resp['data']['getMediaObjects']['items'][0]['mediaId']).toBe(mediaId)

  // set our photo
  resp = await ourClient.mutate({mutation: schema.setUserDetails, variables: {photoMediaId: mediaId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['photoUrl']).toBeTruthy()
  expect(resp['data']['setUserDetails']['photoUrl64p']).toBeTruthy()
  expect(resp['data']['setUserDetails']['photoUrl480p']).toBeTruthy()
  expect(resp['data']['setUserDetails']['photoUrl1080p']).toBeTruthy()
  expect(resp['data']['setUserDetails']['photoUrl4k']).toBeTruthy()

  // check that it is really set already set
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['photoUrl']).toBeTruthy()
  expect(resp['data']['self']['photoUrl64p']).toBeTruthy()
  expect(resp['data']['self']['photoUrl480p']).toBeTruthy()
  expect(resp['data']['self']['photoUrl1080p']).toBeTruthy()
  expect(resp['data']['self']['photoUrl4k']).toBeTruthy()

  // delete our photo
  resp = await ourClient.mutate({mutation: schema.setUserDetails, variables: {photoMediaId: ''}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['photoUrl']).toBeNull()
  expect(resp['data']['setUserDetails']['photoUrl64p']).toBeNull()
  expect(resp['data']['setUserDetails']['photoUrl480p']).toBeNull()
  expect(resp['data']['setUserDetails']['photoUrl1080p']).toBeNull()
  expect(resp['data']['setUserDetails']['photoUrl4k']).toBeNull()

  // check that it is really set already set
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['photoUrl']).toBeNull()
  expect(resp['data']['self']['photoUrl64p']).toBeNull()
  expect(resp['data']['self']['photoUrl480p']).toBeNull()
  expect(resp['data']['self']['photoUrl1080p']).toBeNull()
  expect(resp['data']['self']['photoUrl4k']).toBeNull()
})


test('Read properties of another private user', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // set up another user in cognito, mark them as private
  const theirBio = 'keeping calm and carrying on'
  const theirFullName = 'HG Wells'
  const theirPhone = '+15105551000'
  const [theirClient, theirUserId, , theirEmail] = await cognito.getAppSyncLogin(theirPhone)
  let resp = await theirClient.mutate({mutation: schema.setUserPrivacyStatus, variables: {privacyStatus: 'PRIVATE'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['privacyStatus']).toBe('PRIVATE')
  await theirClient.mutate({mutation: schema.setUserDetails, variables: {bio: theirBio, fullName: theirFullName}})

  // verify they can see all their properties (make sure they're all set correctly)
  resp = await theirClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  let user = resp['data']['self']
  expect(user['followedStatus']).toBe('SELF')
  expect(user['followerStatus']).toBe('SELF')
  expect(user['privacyStatus']).toBe('PRIVATE')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBe(theirBio)
  expect(user['email']).toBe(theirEmail)
  expect(user['phoneNumber']).toBe(theirPhone)

  // verify that we can only see info that is expected of a non-follower
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  user = resp['data']['user']
  expect(user['followedStatus']).toBe('NOT_FOLLOWING')
  expect(user['followerStatus']).toBe('NOT_FOLLOWING')
  expect(user['privacyStatus']).toBe('PRIVATE')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBeNull()
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // request to follow the user, verify we cannot see anything more
  await ourClient.mutate({mutation: schema.followUser, variables: {userId: theirUserId}})
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  user = resp['data']['user']
  expect(user['followedStatus']).toBe('REQUESTED')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBeNull()
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // verify we see the same thing if we access their user profile indirectly
  resp = await ourClient.query({query: schema.ourFollowedUsers, variables: {followStatus: 'REQUESTED'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['followedUsers']['items']).toHaveLength(1)
  user = resp['data']['self']['followedUsers']['items'][0]
  expect(user['followedStatus']).toBe('REQUESTED')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBeNull()
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // accept the user's follow request, verify we can see more
  await theirClient.mutate({mutation: schema.acceptFollowerUser, variables: {userId: ourUserId}})
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  user = resp['data']['user']
  expect(user['followedStatus']).toBe('FOLLOWING')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBe(theirBio)
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // verify we see the same thing if we access their user profile indirectly
  resp = await ourClient.query({query: schema.ourFollowedUsers})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['followedUsers']['items']).toHaveLength(1)
  user = resp['data']['self']['followedUsers']['items'][0]
  expect(user['followedStatus']).toBe('FOLLOWING')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBe(theirBio)
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // now deny the user's follow request, verify we can see less
  await theirClient.mutate({mutation: schema.denyFollowerUser, variables: {userId: ourUserId}})
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  user = resp['data']['user']
  expect(user['followedStatus']).toBe('DENIED')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBeNull()
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // verify we see the same thing if we access their user profile indirectly
  resp = await ourClient.query({query: schema.ourFollowedUsers, variables: {followStatus: 'DENIED'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['followedUsers']['items']).toHaveLength(1)
  user = resp['data']['self']['followedUsers']['items'][0]
  expect(user['followedStatus']).toBe('DENIED')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBeNull()
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // now accept the user's follow request, and then unfollow them
  await theirClient.mutate({mutation: schema.acceptFollowerUser, variables: {userId: ourUserId}})
  await ourClient.mutate({mutation: schema.unfollowUser, variables: {userId: theirUserId}})
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['followedStatus']).toBe('NOT_FOLLOWING')
  expect(resp['data']['user']['fullName']).toBe(theirFullName)
  expect(resp['data']['user']['bio']).toBeNull()
  expect(resp['data']['user']['email']).toBeNull()
  expect(resp['data']['user']['phoneNumber']).toBeNull()
})


test('Read properties of another public user', async () => {
  const [ourClient] = await loginCache.getCleanLogin()

  // set up another user in cognito, leave them as public
  const theirBio = 'keeping calm and carrying on'
  const theirFullName = 'HG Wells'
  const theirPhone = '+14155551212'
  const [theirClient, theirUserId, , theirEmail] = await cognito.getAppSyncLogin(theirPhone)
  await theirClient.mutate({mutation: schema.setUserDetails, variables: {bio: theirBio, fullName: theirFullName}})

  // verify they can see all their properties (make sure they're all set correctly)
  let resp = await theirClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  let user = resp['data']['self']
  expect(user['followedStatus']).toBe('SELF')
  expect(user['followerStatus']).toBe('SELF')
  expect(user['privacyStatus']).toBe('PUBLIC')
  expect(user['fullName']).toBe(theirFullName)
  expect(user['bio']).toBe(theirBio)
  expect(user['email']).toBe(theirEmail)
  expect(user['phoneNumber']).toBe(theirPhone)

  // verify that we can see info that is expected of a non-follower
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  user = resp['data']['user']
  expect(user['followedStatus']).toBe('NOT_FOLLOWING')
  expect(user['followerStatus']).toBe('NOT_FOLLOWING')
  expect(user['privacyStatus']).toBe('PUBLIC')
  expect(user['bio']).toBe(theirBio)
  expect(user['fullName']).toBe(theirFullName)
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()

  // follow the user, and verify we still can't see stuff we shouldn't be able to
  await ourClient.mutate({mutation: schema.followUser, variables: {userId: theirUserId}})
  resp = await ourClient.query({query: schema.user, variables: {userId: theirUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['email']).toBeNull()
  expect(resp['data']['user']['phoneNumber']).toBeNull()

  // verify we can't see anything more if we access their user profile indirectly
  resp = await ourClient.query({query: schema.ourFollowedUsers})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['followedUsers']['items']).toHaveLength(1)
  user = resp['data']['self']['followedUsers']['items'][0]
  expect(user['followedStatus']).toBe('FOLLOWING')
  expect(user['followerStatus']).toBe('NOT_FOLLOWING')
  expect(user['privacyStatus']).toBe('PUBLIC')
  expect(user['bio']).toBe(theirBio)
  expect(user['fullName']).toBe(theirFullName)
  expect(user['email']).toBeNull()
  expect(user['phoneNumber']).toBeNull()
})


test('User language code - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to english
  let resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['languageCode']).toBe('en')

  // we change our language code
  resp = await ourClient.mutate({mutation: schema.setUserLanguageCode, variables: {languageCode: 'de'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['languageCode']).toBe('de')

  // check another user can't see our language
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['languageCode']).toBeNull()
})


test('User theme code - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to 'black.white'
  let resp = await ourClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['themeCode']).toBe('black.white')

  // we change our theme code
  resp = await ourClient.mutate({mutation: schema.setUserThemeCode, variables: {themeCode: 'green.orange'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['themeCode']).toBe('green.orange')

  // we go to private
  resp = await ourClient.mutate({mutation: schema.setUserPrivacyStatus, variables: {privacyStatus: 'PRIVATE'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['privacyStatus']).toBe('PRIVATE')

  // Check to ensure another rando *can* see our themeCode
  // This is necessary because profile pics are planned to have some styling based on chosen theme
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['themeCode']).toBe('green.orange')
})


test('User accepted EULA version - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to null
  let resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['acceptedEULAVersion']).toBeNull()

  // we change our accepted version
  resp = await ourClient.mutate({mutation: schema.setUserAcceptedEULAVersion, variables: {version: '2019-11-14'}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserAcceptedEULAVersion']['acceptedEULAVersion']).toBe('2019-11-14')

  // check to make sure that version stuck
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['acceptedEULAVersion']).toBe('2019-11-14')

  // check another user can't see our acepted version
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['acceptedEULAVersion']).toBeNull()

  // check we can null out accepted version
  resp = await ourClient.mutate({mutation: schema.setUserAcceptedEULAVersion, variables: {version: ''}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserAcceptedEULAVersion']['acceptedEULAVersion']).toBeNull()
})


test('User commentsDisabled - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to false
  let resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['commentsDisabled']).toBe(false)

  // we change it
  resp = await ourClient.mutate({mutation: schema.setUserMentalHealthSettings, variables: {commentsDisabled: true}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['commentsDisabled']).toBe(true)

  // check to make sure that version stuck
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['commentsDisabled']).toBe(true)

  // check another user can't see values
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['commentsDisabled']).toBeNull()
})


test('User likesDisabled - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to false
  let resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['likesDisabled']).toBe(false)

  // we change it
  resp = await ourClient.mutate({mutation: schema.setUserMentalHealthSettings, variables: {likesDisabled: true}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['likesDisabled']).toBe(true)

  // check to make sure that version stuck
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['likesDisabled']).toBe(true)

  // check another user can't see values
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['likesDisabled']).toBeNull()
})


test('User verificationHidden - get, set, privacy', async () => {
  const [ourClient, ourUserId] = await loginCache.getCleanLogin()

  // we should default to false
  let resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['verificationHidden']).toBe(false)

  // we change it
  resp = await ourClient.mutate({
    mutation: schema.setUserMentalHealthSettings,
    variables: {verificationHidden: true}
  })
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['setUserDetails']['verificationHidden']).toBe(true)

  // check to make sure that version stuck
  resp = await ourClient.query({query: schema.self})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['self']['verificationHidden']).toBe(true)

  // check another user can't see values
  const [theirClient] = await loginCache.getCleanLogin()
  resp = await theirClient.query({query: schema.user, variables: {userId: ourUserId}})
  expect(resp['errors']).toBeUndefined()
  expect(resp['data']['user']['verificationHidden']).toBeNull()
})