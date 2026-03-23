const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const testDriveSchema = new mongoose.Schema({
  car_id: {
    type: Number,
    required: true,
    unique: true,
  },
  user_id: {
    type: String,
    required: false, // Can be optional if guest can book
  },
  preferred_date: {
    type: Date,
    required: true,
  },
  preferred_time: {
    type: String,
    required: true,
  },
  preferred_location: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "confirmed", "cancelled", "completed"],
    default: "pending",
  },
  test_drive_id: {
    type: Number,
    unique: true,
  },
});

// Auto increment field for test_drive_id
testDriveSchema.plugin(AutoIncrement, { inc_field: "test_drive_id" });

module.exports = mongoose.model("TestDrive", testDriveSchema);
