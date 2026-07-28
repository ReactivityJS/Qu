// Bundle 3/6 — the "App-Space" toolkit: generic, app-agnostic building
// blocks for a multi-writer, multi-member Space (Spaces themselves,
// membership/discovery, profiles+directory, identity transfer, chat
// primitives, presence/read-receipts, calendar events, incognito
// identities). Built entirely on the public Qu/Session API (see each
// module's own doc) — this is the layer a Chat, ToDo, Forum, CMS, or
// Calendar app plugs into Core through, never a replacement for Core
// itself. Depends on Core; chat.js/presence.js/calendar.js additionally
// benefit from plugins-network.js being installed too (qu.connect()),
// though none of them hard-imports it.
export { createSpaceACLResolver, createSpace, createSpaceAt, createSpacesPlugin, addToRole, removeFromRole } from '../modules/spaces.js';
export {
  inboxId, ensureSpace, notifyMembers, onSpaceInvite, addSpaceMember, removeSpaceMember, createSpaceMembershipPlugin,
  spaceWriterRecipients,
} from '../modules/space-membership.js';
export { notifyUser, onNotification, createNotificationsPlugin } from '../modules/notifications.js';
export { addContact, removeContact, listContacts, onContactsChange, createContactsPlugin } from '../modules/contacts.js';
export { registerDevice, removeDevice, listDevices, onDevicesChange, createDevicesPlugin } from '../modules/devices.js';
export {
  itemInviteBoxId, inviteToItem, onItemInvite, createItemInvitesPlugin, createItemInvitePushRule,
} from '../modules/item-invites.js';
export {
  setProfileAttr, getProfileAttr, deleteProfileAttr, listProfileAttrs, onProfileAttrsChange,
  DIRECTORY_ID, ensureDirectory, setDirectoryVisible, listDirectory, onDirectoryChange, createProfilesPlugin,
} from '../modules/profiles.js';
export { exportIdentity, importIdentity } from '../modules/identity-transfer.js';
export {
  sendMessage, listMessages, onMessage, createChatRoom, createChatPlugin,
  setReaction, clearReaction, getReactions, onReactionsChange,
  pinMessage, unpinMessage, getPinnedMessages, onPinsChange,
  createChatPushRule,
} from '../modules/chat.js';
export {
  markRead, getReadReceipts, onReadReceipt,
  setPresence, getPresence, onPresenceChange, startHeartbeat,
  createPresencePlugin,
} from '../modules/presence.js';
export {
  bucketOf as calendarBucketOf,
  createCalendarSpace, createEvent, updateEvent, deleteEvent, listEvents, onEventsChange,
  inviteToEvent, removeFromEvent, onEventInvites,
  setRSVP, setOutsiderRSVP, getRSVPs, onRSVPChange,
  ensureCalendarSpace, addCalendarMember, removeCalendarMember, onCalendarInvite, notifyCalendarMembers,
  createCalendarPlugin, createCalendarPushRule,
} from '../modules/calendar.js';
export {
  createIncognitoIdentity, listIncognitoIdentities, getIncognitoIdentity, deleteIncognitoIdentity, enterIncognito,
  saveIncognitoIdentity, removeIncognitoIdentity, loadIncognitoStore, onIncognitoIdentitiesChange, createIncognitoPlugin,
} from '../modules/incognito-identity.js';
export {
  createSite, getConfig, onConfig, updateConfig, setNavigationMode,
  setTemplate, getTemplate, onTemplate,
  setPage, getPage, onPage,
  addNavItem, removeNavItem, listNav, onNav,
  presentRoute, onPresentedRoute,
  setHomepageSite, getHomepageSite, onHomepageSiteChange,
  createCmsPlugin,
} from '../modules/cms.js';
