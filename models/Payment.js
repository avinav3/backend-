// models/Payment.js
const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    transaction_id: {
      type: String,
      unique: true,
      required: true,
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
    payment_method: {
      type: String,
      enum: ["credit_card", "debit_card", "upi", "paypal", "khalti"],
      required: true,
    },
    payment_status: {
      type: String,
      enum: ["pending", "success", "paid", "failed", "cancelled", "refunded"],
      default: "pending",
    },
    date_of_payment: {
      type: Date,
      default: Date.now,
    },
    car_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Car",
    },
    booking_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
    },
    booking_reference: {
      type: Number,
      required: false,
      index: true,
    },
    order_reference: {
      type: String,
      required: false,
      trim: true,
    },
    transactionUuid: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      trim: true,
    },
    khaltiPidx: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      trim: true,
    },
    khaltiTransactionId: {
      type: String,
      required: false,
      trim: true,
    },
    paidAt: {
      type: Date,
      required: false,
    },
    additional_details: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent multiple model compilations
const Payment =
  mongoose.models.Payment || mongoose.model("Payment", PaymentSchema);

module.exports = Payment;
