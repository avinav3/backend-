const mongoose = require("mongoose");

// Message Schema (individual messages)
const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["admin", "user"],
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    receiverRole: {
      type: String,
      enum: ["admin", "user"],
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: false,
      trim: true,
    },
    seen: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: true,
  }
);

// Chat Schema (conversation)
const chatSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
    },
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    messages: [messageSchema],
    lastMessage: {
      type: String,
      default: "",
    },
    lastMessageSenderRole: {
      type: String,
      enum: ["admin", "user", null],
      default: null,
    },
    lastMessageTime: {
      type: Date,
      default: Date.now,
    },
    unreadCountForAdmin: {
      type: Number,
      default: 0,
    },
    unreadCountForUser: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Add compound unique index for user and admin
chatSchema.index({ user: 1, admin: 1 }, { unique: true });
chatSchema.index({ lastMessageTime: -1 });

const Message =
  mongoose.models.Message || mongoose.model("Message", messageSchema);

const Chat = mongoose.models.Chat || mongoose.model("Chat", chatSchema);

module.exports = { Message, Chat };
