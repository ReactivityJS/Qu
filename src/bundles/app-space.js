// Bundle 3/6 — the "App-Space" toolkit: generic, app-agnostic building
// blocks for a multi-writer, multi-member Space (Spaces themselves,
// membership/discovery, profiles+directory, identity transfer, chat
// primitives, presence/read-receipts). Built entirely on the public
// Qu/Session API (see each module's own doc) — this is the layer a Chat,
// ToDo, Forum, or CMS app plugs into Core through, never a replacement
// for Core itself. Depends on Core; chat.js/presence.js additionally
// benefit from plugins-network.js being installed too (qu.connect()),
// though neither hard-imports it.
export { createSpaceACLResolver, createSpace, createSpaceAt, createSpacesPlugin, addToRole, removeFromRole } from '../modules/spaces.js';
export {
  inboxId, ensureSpace, notifyMembers, onSpaceInvite, addSpaceMember, removeSpaceMember, createSpaceMembershipPlugin,
} from '../modules/space-membership.js';
export {
  setProfileAttr, getProfileAttr, deleteProfileAttr, listProfileAttrs, onProfileAttrsChange,
  DIRECTORY_ID, ensureDirectory, setDirectoryVisible, listDirectory, onDirectoryChange, createProfilesPlugin,
} from '../modules/profiles.js';
export { exportIdentity, importIdentity } from '../modules/identity-transfer.js';
export {
  sendMessage, listMessages, onMessage, createChatRoom, createChatPlugin,
  setReaction, clearReaction, getReactions, onReactionsChange,
  pinMessage, unpinMessage, getPinnedMessages, onPinsChange,
} from '../modules/chat.js';
export {
  markRead, getReadReceipts, onReadReceipt,
  setPresence, getPresence, onPresenceChange, startHeartbeat,
  createPresencePlugin,
} from '../modules/presence.js';
