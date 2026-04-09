const mongoose = require("mongoose");

const bidSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    user_id: {
      type: String,
      required: false,
      trim: true,
      index: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    userEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CarListing",
      required: true,
      index: true,
    },
    listing_id: {
      type: Number,
      required: false,
      index: true,
    },
    vehicleTitle: {
      type: String,
      required: true,
      trim: true,
    },
    listedPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    bidAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    approvedPrice: {
      type: Number,
      default: null,
      min: 0.01,
    },
    mode: {
      type: String,
      enum: ["rent", "buy"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
    adminNote: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1000,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Keep one active pending bid per user + vehicle + mode to prevent spam duplicates.
bidSchema.index(
  { user: 1, listing: 1, mode: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

bidSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Bid || mongoose.model("Bid", bidSchema);
