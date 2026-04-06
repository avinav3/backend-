const mongoose = require("mongoose");

const FavoriteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    carId: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["buy", "rent"],
      required: true,
      lowercase: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// ## Prevent the same user from favoriting the same car twice in the same category.
FavoriteSchema.index({ user: 1, carId: 1, category: 1 }, { unique: true });

module.exports = mongoose.model("Favorite", FavoriteSchema);
