const express = require("express");
const mongoose = require("mongoose");
const Users = require("../../models/Users");
const Admin = require("../../models/Admin");
const { Chat } = require("../../models/message");
const { extractAccessToken } = require("../../middleware/auth");
const { verifyAccessToken } = require("../../utils/token");
const { getIo } = require("../../utils/socket");

const router = express.Router();

router.use((req, res, next) => {
  req.app.set("etag", false);
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function buildParticipantQuery(userId, adminId) {
  return {
    user: new mongoose.Types.ObjectId(userId),
    admin: new mongoose.Types.ObjectId(adminId),
  };
}

function tryResolveAuth(req) {
  if (req.auth?.id) {
    return req.auth;
  }

  const token = extractAccessToken(req);

  if (!token) {
    return null;
  }

  try {
    const decoded = verifyAccessToken(token);
    req.auth = decoded;
    return decoded;
  } catch (_error) {
    return null;
  }
}

function getRequestActor(req) {
  const auth = tryResolveAuth(req);

  if (auth?.id) {
    return {
      id: String(auth.id),
      role: auth.role === "admin" ? "admin" : "user",
      accountType: auth.accountType || null,
    };
  }

  const legacyRole =
    req.body?.senderRole ||
    req.body?.role ||
    req.query?.senderRole ||
    req.query?.role ||
    req.headers["x-role"] ||
    req.headers.role;
  const legacyId =
    req.body?.senderId ||
    req.body?.sender ||
    req.body?.id ||
    req.body?.customerId ||
    req.body?.userId ||
    req.body?.adminId ||
    req.query?.senderId ||
    req.query?.sender ||
    req.query?.id ||
    req.query?.customerId ||
    req.query?.userId ||
    req.query?.adminId ||
    req.params?.adminId ||
    req.headers["x-user-id"] ||
    req.headers["x-admin-id"] ||
    req.headers["x-sender-id"] ||
    req.headers.userid ||
    req.headers.userId ||
    req.headers.adminid ||
    req.headers.adminId;

  if (!legacyId || !legacyRole) {
    const inferredAdminId =
      req.body?.adminId ||
      req.query?.adminId ||
      req.params?.adminId ||
      req.headers["x-admin-id"] ||
      req.headers.adminid ||
      req.headers.adminId;

    const inferredRole =
      req.body?.role ||
      req.query?.role ||
      req.headers["x-role"] ||
      req.headers.role;

    const inferredUserId =
      req.body?.userId ||
      req.query?.userId ||
      req.headers["x-user-id"] ||
      req.headers.userid ||
      req.headers.userId;

    if (inferredAdminId && String(inferredRole).toLowerCase() !== "user") {
      return {
        id: String(inferredAdminId),
        role: "admin",
        accountType: "admin",
      };
    }

    if (inferredUserId && String(inferredRole).toLowerCase() === "user") {
      return {
        id: String(inferredUserId),
        role: "user",
        accountType: "user",
      };
    }

    return null;
  }

  return {
    id: String(legacyId),
    role: String(legacyRole).toLowerCase() === "admin" ? "admin" : "user",
    accountType:
      String(legacyRole).toLowerCase() === "admin" ? "admin" : "user",
  };
}

async function getPrimaryAdmin() {
  return Admin.findOne().sort({ createdAt: 1 });
}

async function getDefaultAdminActor() {
  const admin = await getPrimaryAdmin();

  if (!admin?._id) {
    return null;
  }

  return {
    id: String(admin._id),
    role: "admin",
    accountType: "admin",
  };
}

async function getChatActor(req, options = {}) {
  const {
    allowDefaultAdmin = false,
    preferAdminForConversationAccess = false,
  } = options;

  const actor = getRequestActor(req);

  if (actor) {
    return actor;
  }

  if (
    allowDefaultAdmin ||
    preferAdminForConversationAccess ||
    req.query?.conversationId ||
    req.query?.chatId ||
    req.params?.conversationId ||
    req.params?.chatId ||
    req.body?.conversationId ||
    req.body?.chatId ||
    req.body?.receiverId ||
    req.body?.adminId ||
    req.query?.adminId
  ) {
    return getDefaultAdminActor();
  }

  return null;
}

function normalizeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function sortMessagesChronologically(messages) {
  return messages.slice().sort((left, right) => {
    const leftDate = normalizeDate(left.createdAt) || new Date(0);
    const rightDate = normalizeDate(right.createdAt) || new Date(0);
    return leftDate - rightDate;
  });
}

function pickCanonicalConversation(conversations) {
  if (!conversations.length) {
    return null;
  }

  return conversations.slice().sort((left, right) => {
    const leftHasMessages = left.messages?.length ? 1 : 0;
    const rightHasMessages = right.messages?.length ? 1 : 0;

    if (leftHasMessages !== rightHasMessages) {
      return rightHasMessages - leftHasMessages;
    }

    const leftTime =
      normalizeDate(left.lastMessageTime || left.updatedAt || left.createdAt) ||
      new Date(0);
    const rightTime =
      normalizeDate(
        right.lastMessageTime || right.updatedAt || right.createdAt,
      ) || new Date(0);
    return rightTime - leftTime;
  })[0];
}

async function consolidateParticipantConversations(userId, adminId) {
  if (!isValidObjectId(userId) || !isValidObjectId(adminId)) {
    return null;
  }

  const conversations = await Chat.find({
    user: userId,
    admin: adminId,
  }).sort({
    lastMessageTime: -1,
    updatedAt: -1,
    createdAt: 1,
  });

  if (!conversations.length) {
    return null;
  }

  const canonicalConversation = pickCanonicalConversation(conversations);

  if (!canonicalConversation || conversations.length === 1) {
    return canonicalConversation || conversations[0];
  }

  const duplicateConversations = conversations.filter(
    (conversation) =>
      String(conversation._id) !== String(canonicalConversation._id),
  );

  const mergedMessages = [];
  const seenMessageIds = new Set();

  conversations.forEach((conversation) => {
    (conversation.messages || []).forEach((message) => {
      const messageId = String(message._id);

      if (seenMessageIds.has(messageId)) {
        return;
      }

      seenMessageIds.add(messageId);
      mergedMessages.push(message.toObject ? message.toObject() : message);
    });
  });

  const orderedMessages = sortMessagesChronologically(mergedMessages);
  const latestMessage = orderedMessages[orderedMessages.length - 1] || null;

  canonicalConversation.messages = orderedMessages;
  canonicalConversation.lastMessage =
    latestMessage?.text ||
    latestMessage?.message ||
    canonicalConversation.lastMessage ||
    "";
  canonicalConversation.lastMessageTime =
    latestMessage?.createdAt ||
    canonicalConversation.lastMessageTime ||
    canonicalConversation.updatedAt ||
    new Date();
  canonicalConversation.lastMessageSenderRole =
    latestMessage?.senderRole ||
    canonicalConversation.lastMessageSenderRole ||
    null;
  canonicalConversation.unreadCountForAdmin = conversations.reduce(
    (total, conversation) => total + (conversation.unreadCountForAdmin || 0),
    0,
  );
  canonicalConversation.unreadCountForUser = conversations.reduce(
    (total, conversation) => total + (conversation.unreadCountForUser || 0),
    0,
  );

  await canonicalConversation.save();

  if (duplicateConversations.length) {
    await Chat.deleteMany({
      _id: {
        $in: duplicateConversations.map((conversation) => conversation._id),
      },
    });
  }

  return canonicalConversation;
}

async function consolidateUserSupportConversations(userId) {
  if (!isValidObjectId(userId)) {
    return null;
  }

  // This helper is kept only as a backward-compatible fallback for older
  // routes. Rewriting and deleting conversation documents during a fetch can
  // race with message sends and trigger Mongoose VersionError, so here we only
  // return the best candidate instead of mutating documents.
  const conversations = await Chat.find({
    user: userId,
  }).sort({
    lastMessageTime: -1,
    updatedAt: -1,
    createdAt: 1,
  });

  if (!conversations.length) {
    return null;
  }

  const canonicalConversation = pickCanonicalConversation(conversations);

  return canonicalConversation;
}

async function getPreferredConversationForParticipants(userId, adminId) {
  if (!isValidObjectId(userId) || !isValidObjectId(adminId)) {
    return null;
  }

  return consolidateParticipantConversations(userId, adminId);
}

async function ensureUserExists(userId) {
  if (!isValidObjectId(userId)) {
    return null;
  }

  return Users.findById(userId).select("_id name email");
}

async function ensureAdminExists(adminId) {
  if (!isValidObjectId(adminId)) {
    return null;
  }

  return Admin.findById(adminId).select("_id name email");
}

async function resolveAdminConversationOwner(actor) {
  if (!actor || actor.role !== "admin") {
    return null;
  }

  // Customer support chat is a shared admin inbox. Customers always message
  // the canonical support-admin conversation, and any authenticated admin
  // should be able to view/reply to that same thread.
  const primaryAdmin = await getPrimaryAdmin();

  if (primaryAdmin) {
    return primaryAdmin;
  }

  return ensureAdminExists(actor.id);
}

function isUnreadMessageForActor(message, actor) {
  if (!message || message.seen) {
    return false;
  }

  if (actor?.role === "admin") {
    return String(message.receiverRole || "").toLowerCase() === "admin";
  }

  return String(message.receiverId) === String(actor?.id || "");
}

async function getOrCreateConversationForUser(userId) {
  const user = await ensureUserExists(userId);

  if (!user) {
    return { error: "User not found." };
  }

  const admin = await getPrimaryAdmin();

  if (!admin) {
    return { error: "No admin account is available." };
  }

  // Keep one isolated conversation per user/admin pair so replies never bleed
  // into another user's thread.
  let conversation = await getPreferredConversationForParticipants(
    user._id,
    admin._id,
  );

  if (!conversation) {
    conversation = await Chat.findOne(buildParticipantQuery(user._id, admin._id));
  }

  if (!conversation) {
    conversation = await Chat.create({
      user: user._id,
      admin: admin._id,
      messages: [],
    });
  }

  return { conversation, user, admin };
}

async function getOrCreateConversationForParticipants(userId, adminId) {
  const user = await ensureUserExists(userId);
  const admin = await ensureAdminExists(adminId);

  if (!user) {
    return { error: "User not found." };
  }

  if (!admin) {
    return { error: "Admin not found." };
  }

  let conversation = await getPreferredConversationForParticipants(
    user._id,
    admin._id,
  );

  if (!conversation) {
    conversation = await Chat.findOne(buildParticipantQuery(user._id, admin._id));
  }

  if (!conversation) {
    conversation = await Chat.create({
      user: user._id,
      admin: admin._id,
      messages: [],
    });
  }

  return { conversation, user, admin };
}

async function getCanonicalConversationFromConversation(conversation) {
  if (!conversation) {
    return null;
  }

  const userId = conversation.user?._id || conversation.user;
  const adminId = conversation.admin?._id || conversation.admin;

  if (
    !userId ||
    !adminId ||
    !isValidObjectId(userId) ||
    !isValidObjectId(adminId)
  ) {
    return conversation;
  }

  return (
    (await getPreferredConversationForParticipants(userId, adminId)) ||
    conversation
  );
}

async function getConversationForRequest({ conversationId, userId, adminId }) {
  if (conversationId && isValidObjectId(conversationId)) {
    const conversation = await Chat.findById(conversationId);
    return getCanonicalConversationFromConversation(conversation);
  }

  if (
    userId &&
    adminId &&
    isValidObjectId(userId) &&
    isValidObjectId(adminId)
  ) {
    const conversation = await Chat.findOne(buildParticipantQuery(userId, adminId));
    return getCanonicalConversationFromConversation(conversation);
  }

  return null;
}

async function resolveConversationByIdentifiers(req, actor) {
  const conversationId =
    req.params.conversationId ||
    req.params.chatId ||
    req.query.conversationId ||
    req.query.chatId ||
    req.body?.conversationId ||
    req.body?.chatId ||
    null;

  let conversation = await getConversationForRequest({ conversationId });

  if (conversation) {
    return conversation;
  }

  // Only treat explicit user/customer identifiers as user selectors.
  // `chatId` and `conversationId` must never silently fall back to a user id,
  // otherwise one bad id can open or create the wrong thread.
  const requestedUserId = resolveRequestedCustomerId(req, actor, {
    includeActorFallback: false,
  });

  if (!requestedUserId || !isValidObjectId(requestedUserId)) {
    return null;
  }

  const adminOwner =
    actor?.role === "admin" ? await resolveAdminConversationOwner(actor) : null;
  const result =
    actor?.role === "admin"
      ? await getOrCreateConversationForParticipants(
          requestedUserId,
          adminOwner?._id,
        )
      : await getOrCreateConversationForUser(requestedUserId);

  if (result.error) {
    return null;
  }

  return result.conversation;
}

function buildMessageResponse(messageDoc) {
  const senderId = messageDoc.senderId || messageDoc.sender || null;
  const text = messageDoc.text || messageDoc.message || "";

  return {
    _id: messageDoc._id,
    id: messageDoc._id,
    sender: senderId,
    senderId,
    senderRole: messageDoc.senderRole,
    receiverId: messageDoc.receiverId || null,
    receiverRole: messageDoc.receiverRole,
    conversationId: messageDoc.conversationId || null,
    chatId: messageDoc.conversationId || null,
    message: text,
    text,
    seen: messageDoc.seen,
    readAt: messageDoc.readAt,
    createdAt: messageDoc.createdAt,
  };
}

function recalculateUnreadCounts(conversation) {
  const nextCounts = (conversation.messages || []).reduce(
    (counts, message) => {
      if (!message || message.seen) {
        return counts;
      }

      if (String(message.receiverRole || "").toLowerCase() === "admin") {
        counts.unreadCountForAdmin += 1;
      } else if (String(message.receiverRole || "").toLowerCase() === "user") {
        counts.unreadCountForUser += 1;
      }

      return counts;
    },
    {
      unreadCountForAdmin: 0,
      unreadCountForUser: 0,
    },
  );

  conversation.unreadCountForAdmin = nextCounts.unreadCountForAdmin;
  conversation.unreadCountForUser = nextCounts.unreadCountForUser;

  return nextCounts;
}

function getUnreadCountForViewer(conversation, viewerRole) {
  return viewerRole === "admin"
    ? conversation.unreadCountForAdmin
    : conversation.unreadCountForUser;
}

function buildConversationResponse(conversation, viewerRole = "admin") {
  const latestMessage =
    conversation.messages[conversation.messages.length - 1] || null;
  const latestMessageText = latestMessage?.text || latestMessage?.message || "";
  const userId = conversation.user?._id || conversation.user;
  const adminId = conversation.admin?._id || conversation.admin;
  const latestMessageResponse = latestMessage
    ? buildMessageResponse(latestMessage)
    : null;

  return {
    _id: conversation._id,
    // Preserve the legacy `id = userId` contract used by older admin chat UIs
    // that open a thread via `/chat/:userId`.
    id: userId,
    conversationDocId: conversation._id,
    conversationId: conversation._id,
    chatId: conversation._id,
    userId,
    customerId: userId,
    adminId,
    participantId: userId,
    user: userId
      ? {
          _id: userId,
          id: userId,
          name: conversation.user?.name || "User",
          email: conversation.user?.email || "",
        }
      : null,
    admin: adminId
      ? {
          _id: adminId,
          id: adminId,
          name: conversation.admin?.name || "Admin",
          email: conversation.admin?.email || "",
        }
      : null,
    userName: conversation.user?.name || "User",
    name: conversation.user?.name || "User",
    userEmail: conversation.user?.email || "",
    email: conversation.user?.email || "",
    lastMessage: conversation.lastMessage || latestMessageText,
    latestMessagePreview: conversation.lastMessage || latestMessageText,
    latestMessage: latestMessageResponse,
    lastMessageTime:
      conversation.lastMessageTime ||
      latestMessage?.createdAt ||
      conversation.updatedAt,
    lastMessageSenderRole:
      conversation.lastMessageSenderRole || latestMessage?.senderRole || null,
    messageCount: conversation.messages?.length || 0,
    unreadCount: getUnreadCountForViewer(conversation, viewerRole),
    unreadCountForAdmin: conversation.unreadCountForAdmin,
    unreadCountForUser: conversation.unreadCountForUser,
    createdAt: conversation.createdAt || null,
    updatedAt: conversation.updatedAt || null,
  };
}

function buildDetailedConversationResponse(conversation, viewerRole = "admin") {
  const baseConversation = buildConversationResponse(conversation, viewerRole);
  const messages = (conversation.messages || [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(buildMessageResponse);

  return {
    ...baseConversation,
    messages,
  };
}

function getUserRoomNames(userId) {
  return [`user:${userId}`, `user_${userId}`];
}

function emitConversationEvents(conversation, message) {
  const io = getIo();

  if (!io) {
    return;
  }

  const userRoomNames = getUserRoomNames(conversation.user);
  const messagePayload = {
    conversationId: conversation._id,
    chatId: conversation._id,
    message,
  };
  const adminConversationPayload = {
    conversation: buildConversationResponse(conversation, "admin"),
    message,
  };
  const userConversationPayload = {
    conversation: buildConversationResponse(conversation, "user"),
    message,
  };

  // Deliver the actual realtime message only to the intended recipient room.
  // The sender already receives the saved message in the HTTP response.
  if (message.senderRole === "user") {
    io.to("admins").emit("chat:message", messagePayload);
  } else {
    let userTarget = io;
    userRoomNames.forEach((roomName) => {
      userTarget = userTarget.to(roomName);
    });
    userTarget.emit("chat:message", messagePayload);
  }

  io.to("admins").emit("chat:conversation-updated", adminConversationPayload);

  let userTarget = io;
  userRoomNames.forEach((roomName) => {
    userTarget = userTarget.to(roomName);
  });
  userTarget.emit("chat:conversation-updated", userConversationPayload);
}

function emitReadEvent(conversation, readerRole) {
  const io = getIo();

  if (!io) {
    return;
  }
  const readPayload = {
    conversationId: conversation._id,
    chatId: conversation._id,
    readerRole,
  };

  io.to("admins").emit("chat:messages-read", readPayload);
  io.to("admins").emit("chat:conversation-read", readPayload);

  let userTarget = io;
  getUserRoomNames(conversation.user).forEach((roomName) => {
    userTarget = userTarget.to(roomName);
  });
  userTarget.emit("chat:messages-read", readPayload);
  userTarget.emit("chat:conversation-read", readPayload);
}

function emitConversationDeletedEvent(conversation) {
  const io = getIo();

  if (!io || !conversation) {
    return;
  }

  const payload = {
    conversationId: conversation._id,
    chatId: conversation._id,
    userId: conversation.user?._id || conversation.user || null,
    customerId: conversation.user?._id || conversation.user || null,
    adminId: conversation.admin?._id || conversation.admin || null,
  };

  io.to("admins").emit("chat:conversation-deleted", payload);

  let userTarget = io;
  getUserRoomNames(conversation.user?._id || conversation.user).forEach(
    (roomName) => {
      userTarget = userTarget.to(roomName);
    },
  );
  userTarget.emit("chat:conversation-deleted", payload);
}

async function populateConversation(conversationId) {
  return Chat.findById(conversationId)
    .populate("user", "_id name email")
    .populate("admin", "_id name email");
}

async function fetchPopulatedConversationForActor(conversationId, actor) {
  if (!conversationId || !isValidObjectId(conversationId)) {
    return null;
  }

  const conversation = await populateConversation(conversationId);

  if (!conversation) {
    return null;
  }

  if (actor.role === "admin") {
    const adminOwner = await resolveAdminConversationOwner(actor);

    if (
      String(conversation.admin?._id || conversation.admin) !==
      String(adminOwner?._id || "")
    ) {
      return null;
    }
  } else if (String(conversation.user?._id || conversation.user) !== String(actor.id)) {
    return null;
  }

  return conversation;
}

async function resolveSelectedConversationForActor(req, actor) {
  const routeUserIdentifier = req.params?.userId || req.params?.customerId || null;
  const requestedConversationId =
    req.params?.conversationId ||
    req.params?.chatId ||
    req.query?.conversationId ||
    req.query?.chatId ||
    req.body?.conversationId ||
    req.body?.chatId ||
    null;

  if (requestedConversationId) {
    return fetchPopulatedConversationForActor(requestedConversationId, actor);
  }

  // Older admin chat pages sometimes call `/chat/:id` with a conversation
  // document id instead of a user id. Accept that form directly before trying
  // to resolve the identifier as a user/customer id.
  if (routeUserIdentifier && isValidObjectId(routeUserIdentifier)) {
    const conversationFromRouteId = await fetchPopulatedConversationForActor(
      routeUserIdentifier,
      actor,
    );

    if (conversationFromRouteId) {
      return conversationFromRouteId;
    }
  }

  const requestedUserId = resolveRequestedCustomerId(req, actor, {
    includeActorFallback: actor.role !== "admin",
  });

  if (!requestedUserId || !isValidObjectId(requestedUserId)) {
    return null;
  }

  const result =
    actor.role === "admin"
      ? await getOrCreateConversationForParticipants(
          requestedUserId,
          (await resolveAdminConversationOwner(actor))?._id,
        )
      : await getOrCreateConversationForUser(requestedUserId);

  if (result?.error || !result?.conversation?._id) {
    return null;
  }

  return populateConversation(result.conversation._id);
}

async function sendDetailedConversationResponse(res, conversation, viewerRole) {
  const detailedConversation = buildDetailedConversationResponse(
    conversation,
    viewerRole,
  );
  const messages = detailedConversation.messages;

  return res.status(200).json({
    flag: "1",
    success: true,
    status: true,
    conversation: detailedConversation,
    chat: detailedConversation,
    user: detailedConversation,
    customer: detailedConversation,
    conversationData: detailedConversation,
    chatData: detailedConversation,
    userData: detailedConversation,
    customerData: detailedConversation,
    selectedChat: detailedConversation,
    selectedConversation: detailedConversation,
    messages,
    messageData: messages,
    messageList: messages,
    allMessages: messages,
    chatMessages: messages,
    chatHistory: messages,
    chatHistroy: messages,
    results: messages,
    rows: messages,
    data: {
      conversation: detailedConversation,
      chat: detailedConversation,
      user: detailedConversation,
      customer: detailedConversation,
      messages,
      messageData: messages,
      messageList: messages,
      allMessages: messages,
      chatMessages: messages,
      chatHistory: messages,
      chatHistroy: messages,
    },
  });
}

async function handleAdminConversationByUserId(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ flag: "0", message: "Admin access is required." });
    }

    const userId = req.params?.userId || req.params?.customerId || null;

    if (!userId || !isValidObjectId(userId)) {
      return res
        .status(400)
        .json({ flag: "0", message: "A valid userId is required." });
    }

    const adminOwner = await resolveAdminConversationOwner(actor);

    if (!adminOwner?._id) {
      return res
        .status(404)
        .json({ flag: "0", message: "Admin account not found." });
    }

    // `/admin/:userId` is a user-thread lookup, not a conversation-id lookup.
    // Only return the thread that belongs to the selected user and the
    // currently authenticated admin. Do not create a new chat while fetching.
    const conversation = await getPreferredConversationForParticipants(
      userId,
      adminOwner._id,
    );

    if (!conversation) {
      return res.status(200).json({
        flag: "1",
        success: true,
        status: true,
        messages: [],
        messageData: [],
        messageList: [],
        allMessages: [],
        chatMessages: [],
        chatHistory: [],
        chatHistroy: [],
        chat: null,
        conversation: null,
        selectedChat: null,
        selectedConversation: null,
        message: "No chat yet",
        data: {
          messages: [],
          chat: null,
          conversation: null,
        },
      });
    }

    const populatedConversation = await populateConversation(conversation._id);

    if (!populatedConversation) {
      return res.status(200).json({
        flag: "1",
        success: true,
        status: true,
        messages: [],
        messageData: [],
        messageList: [],
        allMessages: [],
        chatMessages: [],
        chatHistory: [],
        chatHistroy: [],
        chat: null,
        conversation: null,
        selectedChat: null,
        selectedConversation: null,
        message: "No chat yet",
        data: {
          messages: [],
          chat: null,
          conversation: null,
        },
      });
    }

    if (String(populatedConversation.user?._id || populatedConversation.user) !== String(userId)) {
      return res.status(404).json({
        flag: "0",
        message: "Chat not found.",
      });
    }

    const unreadField = "unreadCountForAdmin";

    if (populatedConversation[unreadField] > 0) {
      let updatedCount = 0;

      populatedConversation.messages.forEach((message) => {
        if (isUnreadMessageForActor(message, actor)) {
          message.seen = true;
          message.readAt = new Date();
          updatedCount += 1;
        }
      });

      if (updatedCount > 0 || populatedConversation[unreadField] !== 0) {
        recalculateUnreadCounts(populatedConversation);
        await populatedConversation.save();
        emitReadEvent(populatedConversation, "admin");
      }
    }

    return sendDetailedConversationResponse(res, populatedConversation, "admin");
  } catch (error) {
    console.error("Fetch admin conversation by user error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch admin conversation.",
    });
  }
}

async function resolveConversationForRead(req, actor) {
  const requestedConversationId =
    req.params?.conversationId ||
    req.params?.chatId ||
    req.params?.id ||
    req.body?.conversationId ||
    req.body?.chatId ||
    req.body?.id ||
    req.query?.conversationId ||
    req.query?.chatId ||
    req.query?.id ||
    null;

  if (requestedConversationId && isValidObjectId(requestedConversationId)) {
    const directConversation = await Chat.findById(requestedConversationId);

    if (directConversation) {
      return directConversation;
    }
  }

  // Older clients call `/read/:id` and `/mark-read/:id` with a user/customer id
  // instead of a conversation id. Treat `:conversationId` and `:chatId` as
  // possible participant identifiers when no chat document exists for them.
  const requestedUserId =
    req.params?.conversationId ||
    req.params?.chatId ||
    resolveRequestedCustomerId(req, actor);

  if (requestedUserId && isValidObjectId(requestedUserId)) {
    const adminOwner =
      actor?.role === "admin" ? await resolveAdminConversationOwner(actor) : null;
    const result =
      actor?.role === "admin"
        ? await getOrCreateConversationForParticipants(
            requestedUserId,
            adminOwner?._id,
          )
        : await getOrCreateConversationForUser(actor.id);
    return result.error ? null : result.conversation;
  }

  return null;
}

async function resolveAdminReplyConversation(req, adminId) {
  const requestedConversationId =
    req.body?.conversationId ||
    req.body?.chatId ||
    req.params?.conversationId ||
    req.params?.chatId ||
    req.query?.conversationId ||
    req.query?.chatId ||
    null;

  if (!requestedConversationId || !isValidObjectId(requestedConversationId)) {
    return null;
  }

  const conversation = await Chat.findById(requestedConversationId);

  if (!conversation) {
    return null;
  }

  const canonicalConversation =
    await getCanonicalConversationFromConversation(conversation);

  if (
    !canonicalConversation ||
    String(canonicalConversation.admin) !== String(adminId)
  ) {
    return null;
  }

  return canonicalConversation;
}

async function resolveConversationForDelete(req, actor) {
  const requestedConversationId =
    req.params?.conversationId ||
    req.params?.chatId ||
    req.params?.id ||
    req.body?.conversationId ||
    req.body?.chatId ||
    req.body?.id ||
    req.query?.conversationId ||
    req.query?.chatId ||
    req.query?.id ||
    null;

  if (requestedConversationId && isValidObjectId(requestedConversationId)) {
    const directConversation = await Chat.findById(requestedConversationId);

    if (directConversation) {
      return getCanonicalConversationFromConversation(directConversation);
    }
  }

  const requestedUserId =
    req.params?.userId ||
    req.params?.customerId ||
    req.params?.chatId ||
    req.params?.conversationId ||
    req.query?.userId ||
    req.query?.customerId ||
    req.body?.userId ||
    req.body?.customerId ||
    null;

  if (!requestedUserId || !isValidObjectId(requestedUserId)) {
    return null;
  }

  if (actor.role === "admin") {
    const adminOwner = await resolveAdminConversationOwner(actor);

    if (!adminOwner?._id) {
      return null;
    }

    return getPreferredConversationForParticipants(
      requestedUserId,
      adminOwner._id,
    );
  }

  const ownConversation = await Chat.findOne(
    buildParticipantQuery(actor.id, requestedUserId),
  );

  return getCanonicalConversationFromConversation(ownConversation);
}

async function handleDeleteConversation(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
      preferAdminForConversationAccess: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const conversation = await resolveConversationForDelete(req, actor);

    if (!conversation) {
      return res
        .status(404)
        .json({ flag: "0", message: "Conversation not found." });
    }

    if (actor.role === "admin") {
      const adminOwner = await resolveAdminConversationOwner(actor);

      if (
        String(conversation.admin?._id || conversation.admin) !==
        String(adminOwner?._id || "")
      ) {
        return res.status(403).json({ flag: "0", message: "Access denied." });
      }
    } else if (String(conversation.user?._id || conversation.user) !== String(actor.id)) {
      return res.status(403).json({ flag: "0", message: "Access denied." });
    }

    const deletedConversation = {
      _id: conversation._id,
      user: conversation.user,
      admin: conversation.admin,
    };

    await Chat.deleteOne({ _id: conversation._id });
    emitConversationDeletedEvent(deletedConversation);

    return res.status(200).json({
      flag: "1",
      success: true,
      status: true,
      message: "Conversation deleted successfully.",
      conversationId: deletedConversation._id,
      chatId: deletedConversation._id,
    });
  } catch (error) {
    console.error("Delete conversation error:", error);
    return res
      .status(500)
      .json({ flag: "0", message: "Failed to delete conversation." });
  }
}

async function handleMarkRead(req, res) {
  try {
    const actor = getRequestActor(req);

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const conversation = await resolveConversationForRead(req, actor);

    if (!conversation) {
      return res
        .status(404)
        .json({ flag: "0", message: "Conversation not found." });
    }

    const isAdmin = actor.role === "admin";
    const isOwner = String(conversation.user) === String(actor.id);

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ flag: "0", message: "Access denied." });
    }

    let updatedCount = 0;

    conversation.messages.forEach((message) => {
      if (isUnreadMessageForActor(message, actor)) {
        message.seen = true;
        message.readAt = new Date();
        updatedCount += 1;
      }
    });

    recalculateUnreadCounts(conversation);
    await conversation.save();
    emitReadEvent(conversation, isAdmin ? "admin" : "user");

    return res.status(200).json({
      flag: "1",
      message: "Messages marked as read.",
      updatedCount,
    });
  } catch (error) {
    console.error("Mark read error:", error);
    return res
      .status(500)
      .json({ flag: "0", message: "Failed to mark messages as read." });
  }
}

async function handleFetchConversationMessages(req, res) {
  try {
    const actor = await getChatActor(req, {
      preferAdminForConversationAccess: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const resolvedConversation = await resolveConversationByIdentifiers(
      req,
      actor,
    );
    const conversation = resolvedConversation
      ? await populateConversation(resolvedConversation._id)
      : null;

    if (!conversation) {
      return res.status(404).json({ flag: "0", message: "Chat not found." });
    }

    const adminOwner =
      actor.role === "admin" ? await resolveAdminConversationOwner(actor) : null;
    const isAllowed =
      (actor.role === "admin" &&
        String(conversation.admin?._id || conversation.admin) ===
          String(adminOwner?._id || "")) ||
      String(conversation.user._id) === String(actor.id);

    if (!isAllowed) {
      return res.status(403).json({ flag: "0", message: "Access denied." });
    }

    const requestedUserId = resolveRequestedCustomerId(req, actor, {
      includeActorFallback: false,
    });

    if (
      actor.role === "admin" &&
      requestedUserId &&
      String(conversation.user._id) !== String(requestedUserId)
    ) {
      return res.status(404).json({ flag: "0", message: "Chat not found." });
    }

    const isViewingAsAdmin = actor.role === "admin";
    const unreadField = isViewingAsAdmin
      ? "unreadCountForAdmin"
      : "unreadCountForUser";

    if (conversation[unreadField] > 0) {
      let updatedCount = 0;

      conversation.messages.forEach((message) => {
        if (isUnreadMessageForActor(message, actor)) {
          message.seen = true;
          message.readAt = new Date();
          updatedCount += 1;
        }
      });

      if (updatedCount > 0 || conversation[unreadField] !== 0) {
        recalculateUnreadCounts(conversation);
        await conversation.save();
        emitReadEvent(conversation, isViewingAsAdmin ? "admin" : "user");
      }
    }

    const viewerRole = actor.role === "admin" ? "admin" : "user";
    return sendDetailedConversationResponse(res, conversation, viewerRole);
  } catch (error) {
    console.error("Fetch chat history error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

async function handleSendMessage(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res.status(401).json({
        flag: "0",
        message: "Authentication required to send messages.",
      });
    }

    const text = String(req.body.message || req.body.text || "").trim();

    if (!text) {
      return res
        .status(400)
        .json({ flag: "0", message: "Message text is required." });
    }

    let conversation;
    let user;
    let admin;

    if (actor.role === "admin") {
      const adminOwner = await resolveAdminConversationOwner(actor);

      if (!adminOwner) {
        return res.status(404).json({
          flag: "0",
          message: "Admin account is not available for chat.",
        });
      }

      const requestedConversation = await resolveAdminReplyConversation(
        req,
        adminOwner._id,
      );

      const receiverId =
        req.body.receiverId ||
        req.body.userId ||
        req.body.customerId ||
        requestedConversation?.user ||
        null;

      if (!receiverId) {
        return res
          .status(400)
          .json({ flag: "0", message: "receiverId is required for admin." });
      }

      const participantConversation =
        await getOrCreateConversationForParticipants(
          receiverId,
          adminOwner._id,
        );

      if (participantConversation.error) {
        return res
          .status(404)
          .json({ flag: "0", message: participantConversation.error });
      }

      user = participantConversation.user;
      admin = participantConversation.admin;
      conversation =
        requestedConversation ||
        (await getConversationForRequest({
          conversationId: req.body.conversationId,
          userId: user._id,
          adminId: admin._id,
        })) ||
        (await getConversationForRequest({
          conversationId: req.body.chatId,
          userId: user._id,
          adminId: admin._id,
        })) ||
        participantConversation.conversation;

      if (
        String(conversation.user) !== String(user._id) ||
        String(conversation.admin) !== String(admin._id)
      ) {
        return res.status(403).json({
          flag: "0",
          message: "Conversation does not belong to the selected user.",
        });
      }
    } else {
      const result = await getOrCreateConversationForUser(actor.id);

      if (result.error) {
        return res.status(404).json({ flag: "0", message: result.error });
      }

      conversation = result.conversation;
      user = result.user;
      admin = result.admin;
    }

    const senderRole = actor.role === "admin" ? "admin" : "user";
    const receiverRole = senderRole === "admin" ? "user" : "admin";
    const receiverId = senderRole === "admin" ? user._id : admin._id;
    const senderId = actor.id;

    const newMessage = {
      sender: senderId,
      senderId,
      senderRole,
      receiverId,
      receiverRole,
      conversationId: conversation._id,
      text,
      message: text,
      seen: false,
      readAt: null,
      createdAt: new Date(),
    };

    conversation.messages.push(newMessage);
    conversation.lastMessage = text;
    conversation.lastMessageTime = newMessage.createdAt;
    conversation.lastMessageSenderRole = senderRole;

    recalculateUnreadCounts(conversation);
    await conversation.save();

    const populatedConversation = await populateConversation(conversation._id);
    const savedMessage =
      populatedConversation.messages[populatedConversation.messages.length - 1];
    const messageResponse = buildMessageResponse(savedMessage);

    emitConversationEvents(populatedConversation, messageResponse);

    return res.status(201).json({
      flag: "1",
      message: "Message sent successfully.",
      data: messageResponse,
      conversation: buildConversationResponse(
        populatedConversation,
        senderRole === "admin" ? "admin" : "user",
      ),
    });
  } catch (error) {
    console.error("Send message error:", error);
    return res
      .status(500)
      .json({ flag: "0", message: "Failed to send message." });
  }
}

async function handleCreateConversation(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const userId =
      actor.role === "admin"
        ? req.body.userId || req.body.customerId
        : actor.id;
    const result =
      actor.role === "admin"
        ? await getOrCreateConversationForParticipants(
            userId,
            (await resolveAdminConversationOwner(actor))?._id,
          )
        : await getOrCreateConversationForUser(userId);

    if (result.error) {
      return res.status(404).json({ flag: "0", message: result.error });
    }

    const conversation = await populateConversation(result.conversation._id);

    return res.status(200).json({
      flag: "1",
      message: "Conversation ready.",
      conversation: buildConversationResponse(
        conversation,
        actor.role === "admin" ? "admin" : "user",
      ),
      chat: buildConversationResponse(
        conversation,
        actor.role === "admin" ? "admin" : "user",
      ),
    });
  } catch (error) {
    console.error("Create conversation error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

function resolveRequestedCustomerId(req, actor, options = {}) {
  const { includeActorFallback = true } = options;

  return (
    req.params.customerId ||
    req.params.userId ||
    req.query.customerId ||
    req.query.userId ||
    req.query.id ||
    req.body?.customerId ||
    req.body?.userId ||
    req.body?.id ||
    (includeActorFallback && actor?.role === "user" ? actor.id : null) ||
    null
  );
}

async function handleCustomerConversation(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const conversation = await resolveSelectedConversationForActor(req, actor);

    if (!conversation) {
      if (actor.role === "admin") {
        return handleConversationList(req, res);
      }

      return res.status(200).json({
        flag: "1",
        success: true,
        status: true,
        messages: [],
        messageData: [],
        messageList: [],
        allMessages: [],
        chatMessages: [],
        chatHistory: [],
        chatHistroy: [],
        chat: null,
        conversation: null,
        selectedChat: null,
        selectedConversation: null,
        message: "No chat yet",
        data: {
          messages: [],
          chat: null,
          conversation: null,
        },
      });
    }

    return sendDetailedConversationResponse(
      res,
      conversation,
      actor.role === "admin" ? "admin" : "user",
    );
  } catch (error) {
    console.error("Fetch customer messages error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

async function handleConversationList(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const adminOwner =
      actor.role === "admin" ? await resolveAdminConversationOwner(actor) : null;
    const query =
      actor.role === "admin" ? { admin: adminOwner?._id } : { user: actor.id };
    const viewerRole = actor.role === "admin" ? "admin" : "user";
    const conversations = await Chat.find(query)
      .populate("user", "_id name email")
      .populate("admin", "_id name email")
      .sort({ lastMessageTime: -1, updatedAt: -1 });
    const responseRows = conversations.map((conversation) =>
      buildConversationResponse(conversation, viewerRole),
    );

    return res.status(200).json({
      flag: "1",
      users: responseRows,
      conversations: responseRows,
      data: responseRows,
    });
  } catch (error) {
    console.error("Fetch conversations error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

async function handleAdminUserList(req, res) {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ flag: "0", message: "Admin access is required." });
    }

    const adminOwner = await resolveAdminConversationOwner(actor);

    const [users, conversations] = await Promise.all([
      Users.find()
        .select("_id name email status createdAt")
        .sort({ name: 1, createdAt: -1 }),
      Chat.find({ admin: adminOwner?._id })
        .select(
          "user admin messages lastMessage lastMessageTime unreadCountForAdmin unreadCountForUser updatedAt createdAt",
        )
        .sort({ lastMessageTime: -1, updatedAt: -1, createdAt: -1 }),
    ]);

    const conversationByUserId = new Map();

    conversations.forEach((conversation) => {
      const userId = String(conversation.user);
      const existingConversation = conversationByUserId.get(userId);

      if (!existingConversation) {
        conversationByUserId.set(userId, conversation);
      }
    });

    const userRows = users.map((user) => {
      const existingConversation = conversationByUserId.get(String(user._id));
      const hasMessages = Boolean(existingConversation?.messages?.length);
      const preview = hasMessages
        ? existingConversation.lastMessage || "No messages yet"
        : "No messages yet";
      const sortTime =
        normalizeDate(existingConversation?.lastMessageTime) ||
        normalizeDate(existingConversation?.updatedAt) ||
        null;

      return {
        id: user._id,
        userId: user._id,
        customerId: user._id,
        name: user.name,
        userName: user.name,
        email: user.email,
        userEmail: user.email,
        status: user.status,
        conversationId: existingConversation?._id || null,
        chatId: existingConversation?._id || null,
        lastMessage: preview,
        latestMessagePreview: preview,
        lastMessageTime: hasMessages
          ? existingConversation?.lastMessageTime || null
          : null,
        unreadCountForAdmin: existingConversation?.unreadCountForAdmin || 0,
        unreadCountForUser: existingConversation?.unreadCountForUser || 0,
        hasConversation: Boolean(existingConversation),
        hasMessages,
        sortTime,
      };
    });

    userRows.sort((left, right) => {
      if (left.hasMessages !== right.hasMessages) {
        return left.hasMessages ? -1 : 1;
      }

      if (left.sortTime && right.sortTime) {
        return right.sortTime - left.sortTime;
      }

      if (left.sortTime) {
        return -1;
      }

      if (right.sortTime) {
        return 1;
      }

      return String(left.name || "").localeCompare(String(right.name || ""));
    });

    return res.status(200).json({
      flag: "1",
      users: userRows.map(({ hasMessages, sortTime, ...userRow }) => userRow),
    });
  } catch (error) {
    console.error("Fetch admin user directory error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

function handleReplyAlias(req, res) {
  if (req.params.conversationId && !req.body?.conversationId) {
    req.body = {
      ...req.body,
      conversationId: req.params.conversationId,
    };
  }

  return handleSendMessage(req, res);
}

function handleReadAlias(req, res) {
  if (req.params.conversationId && !req.body?.conversationId) {
    req.body = {
      ...req.body,
      conversationId: req.params.conversationId,
    };
  }

  return handleMarkRead(req, res);
}

router.post("/chat/create", handleCreateConversation);

router.post("/send", handleSendMessage);
router.post("/send/:conversationId", handleReplyAlias);
router.post("/reply", handleSendMessage);
router.post("/reply/:conversationId", handleReplyAlias);
router.post("/admin/reply", handleSendMessage);
router.post("/admin/send", handleSendMessage);
router.post("/admin/sendmessage", handleSendMessage);
router.post("/chat/reply", handleSendMessage);
router.post("/conversations/:conversationId/reply", handleReplyAlias);
router.post("/admin/conversations/:conversationId/reply", handleReplyAlias);

router.get("/chats", async (req, res) => {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ flag: "0", message: "Admin access is required." });
    }

    const adminOwner = await resolveAdminConversationOwner(actor);
    const conversations = await Chat.find({ admin: adminOwner?._id })
      .populate("user", "_id name email")
      .populate("admin", "_id name email")
      .sort({ lastMessageTime: -1, updatedAt: -1 });

    return res.status(200).json({
      flag: "1",
      conversations: conversations.map((conversation) =>
        buildConversationResponse(conversation, "admin"),
      ),
    });
  } catch (error) {
    console.error("Fetch admin chats error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/conversations", handleConversationList);

router.get("/admin/conversations", async (req, res) => {
  req.query.role = req.query.role || "admin";
  return handleConversationList(req, res);
});
router.get("/admin/users", handleAdminUserList);

router.get("/admin/:userId", handleAdminConversationByUserId);

router.get("/chat/users", async (req, res) => {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ flag: "0", message: "Admin access is required." });
    }

    const adminOwner = await resolveAdminConversationOwner(actor);
    const conversations = await Chat.find({ admin: adminOwner?._id })
      .populate("user", "_id name email")
      .populate("admin", "_id name email")
      .sort({ lastMessageTime: -1, updatedAt: -1 });

    return res.status(200).json({
      flag: "1",
      users: conversations.map((conversation) =>
        buildConversationResponse(conversation, "admin"),
      ),
    });
  } catch (error) {
    console.error("Fetch chat user list error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/customer", handleCustomerConversation);
router.get("/customer/:customerId", handleCustomerConversation);

// Legacy admin/user chat loader used by older frontend chat services.
// - admin + no user id => list conversations
// - admin + user/customer id => selected user conversation
// - user => own conversation
router.get("/chat", async (req, res) => {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    const requestedUserId = resolveRequestedCustomerId(req, actor, {
      includeActorFallback: actor.role !== "admin",
    });

    if (!requestedUserId && actor.role === "admin") {
      return handleConversationList(req, res);
    }

    const conversation = await resolveSelectedConversationForActor(req, actor);

    if (!conversation) {
      return res.status(404).json({ flag: "0", message: "Chat not found." });
    }

    return sendDetailedConversationResponse(
      res,
      conversation,
      actor.role === "admin" ? "admin" : "user",
    );
  } catch (error) {
    console.error("Legacy chat route error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/chat/:userId", async (req, res) => {
  try {
    const actor = await getChatActor(req, {
      allowDefaultAdmin: true,
    });

    if (!actor) {
      return res
        .status(401)
        .json({ flag: "0", message: "Authentication required." });
    }

    req.query = {
      ...req.query,
      userId: req.params.userId,
    };

    const conversation = await resolveSelectedConversationForActor(req, actor);

    if (!conversation) {
      return res.status(404).json({ flag: "0", message: "Chat not found." });
    }

    return sendDetailedConversationResponse(
      res,
      conversation,
      actor.role === "admin" ? "admin" : "user",
    );
  } catch (error) {
    console.error("Fetch chat by user error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/chat/messages/:chatId", handleFetchConversationMessages);
router.get(
  "/admin/conversations/:conversationId/messages",
  handleFetchConversationMessages,
);
router.get("/admin/conversations/:chatId", async (req, res) => {
  req.params.conversationId = req.params.chatId;
  // Keep this alias compatible with frontends that still navigate using a
  // selected user id instead of the newer conversation document id.
  req.query = {
    ...req.query,
    userId: req.query.userId || req.params.chatId,
  };
  req.query.role = req.query.role || "admin";
  return handleFetchConversationMessages(req, res);
});

// ## Backward-compatible aliases used by older frontend pages.
router.post("/sendmessage", handleSendMessage);
router.post("/send-message", handleSendMessage);
router.post("/createChat", handleCreateConversation);
router.post("/CreateChat", handleCreateConversation);
router.get("/chatHistroy/:chatId", handleFetchConversationMessages);
router.get("/chatHistory/:chatId", handleFetchConversationMessages);
router.get("/MessageList", async (req, res) => {
  const actor = await getChatActor(req, {
    allowDefaultAdmin: true,
  });

  if (!actor) {
    return res
      .status(401)
      .json({ flag: "0", message: "Authentication required." });
  }

  if (actor.role === "admin") {
    const adminOwner = await resolveAdminConversationOwner(actor);

    return Chat.find({ admin: adminOwner?._id })
      .populate("user", "_id name email")
      .populate("admin", "_id name email")
      .sort({ lastMessageTime: -1, updatedAt: -1 })
      .then((conversations) =>
        res.status(200).json({
          flag: "1",
          users: conversations.map((conversation) =>
            buildConversationResponse(conversation, "admin"),
          ),
          conversations: conversations.map((conversation) =>
            buildConversationResponse(conversation, "admin"),
          ),
        }),
      )
      .catch((error) => {
        console.error("Fetch MessageList error:", error);
        return res.status(500).json({ flag: "0", message: "Database error" });
      });
  }

  return Chat.find({ user: actor.id })
    .populate("user", "_id name email")
    .populate("admin", "_id name email")
    .sort({ lastMessageTime: -1 })
    .then((conversations) =>
      res.status(200).json({
        flag: "1",
        users: conversations.map((conversation) =>
          buildConversationResponse(conversation, "user"),
        ),
        conversations: conversations.map((conversation) =>
          buildConversationResponse(conversation, "user"),
        ),
      }),
    )
    .catch((error) => {
      console.error("Fetch MessageList error:", error);
      return res.status(500).json({ flag: "0", message: "Database error" });
    });
});

router.get("/conversations/:conversationId/messages", async (req, res) => {
  req.params.chatId = req.params.conversationId;
  return handleFetchConversationMessages(req, res);
});

router.delete("/conversations/:conversationId", handleDeleteConversation);
router.delete("/admin/conversations/:conversationId", handleDeleteConversation);
router.delete("/chat/:chatId", handleDeleteConversation);
router.delete("/admin/:userId", handleDeleteConversation);

router.post("/conversations/:conversationId/read", handleMarkRead);
router.patch("/conversations/:conversationId/read", handleMarkRead);
router.post("/admin/conversations/:conversationId/read", handleMarkRead);
router.patch("/admin/conversations/:conversationId/read", handleMarkRead);
router.post("/read", handleReadAlias);
router.patch("/read", handleReadAlias);
router.post("/read/:conversationId", handleReadAlias);
router.patch("/read/:conversationId", handleReadAlias);
router.post("/mark-read", handleReadAlias);
router.patch("/mark-read", handleReadAlias);
router.post("/mark-read/:conversationId", handleReadAlias);
router.patch("/mark-read/:conversationId", handleReadAlias);

// ## Backward-compatible alias for existing clients.
router.post("/chat/read/:conversationId", handleMarkRead);
router.patch("/chat/read/:conversationId", handleMarkRead);

module.exports = router;
