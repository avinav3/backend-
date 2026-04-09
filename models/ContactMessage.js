const mongoose = require("mongoose");

const ContactMessageSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["new", "read", "replied"],
      default: "new",
    },
    emailSent: {
      type: Boolean,
      default: false,
    },
    emailSentAt: {
      type: Date,
      default: null,
    },
    adminNotes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

ContactMessageSchema.index({ createdAt: -1 });
ContactMessageSchema.index({ email: 1, createdAt: -1 });

module.exports =
  mongoose.models.ContactMessage ||
  mongoose.model("ContactMessage", ContactMessageSchema);
