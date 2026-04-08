//api/payments
const express = require("express");
const Payment = require("../models/Payment");
const User = require("../models/Users"); // Adjust path as needed
const Booking = require("../models/Booking");
const { authenticateAccessToken } = require("../middleware/auth");
// const Payment = require('../models/payment');
const ObjectId = require("mongodb").ObjectId;
const router = express.Router();

function getRequiredKhaltiConfig() {
  return {
    secretKey: process.env.KHALTI_SECRET_KEY,
    gatewayBaseUrl:
      process.env.KHALTI_GATEWAY_BASE_URL || "https://dev.khalti.com/api/v2",
    websiteUrl: process.env.KHALTI_WEBSITE_URL || process.env.CLIENT_SUCCESS_REDIRECT,
    serverBaseUrl: process.env.SERVER_BASE_URL,
    clientSuccessRedirect: process.env.CLIENT_SUCCESS_REDIRECT,
    clientFailureRedirect: process.env.CLIENT_FAILURE_REDIRECT,
  };
}

function validateKhaltiConfig(config) {
  return Object.entries({
    KHALTI_SECRET_KEY: config.secretKey,
    KHALTI_WEBSITE_URL: config.websiteUrl,
    SERVER_BASE_URL: config.serverBaseUrl,
    CLIENT_SUCCESS_REDIRECT: config.clientSuccessRedirect,
    CLIENT_FAILURE_REDIRECT: config.clientFailureRedirect,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTransactionUuid(referencePrefix) {
  return `${referencePrefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

function normalizeKhaltiAmountInPaisa(reqAmount, reqBody = {}) {
  const directPaisa =
    normalizeAmount(reqBody.amount_in_paisa) ??
    normalizeAmount(reqBody.amountPaisa) ??
    normalizeAmount(reqBody.total_amount);

  if (directPaisa !== null) {
    return Math.round(directPaisa);
  }

  const rupees = normalizeAmount(reqAmount);

  if (rupees === null) {
    return null;
  }

  return Math.round(rupees * 100);
}

function buildKhaltiHeaders(secretKey) {
  return {
    Authorization: `Key ${secretKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function normalizeKhaltiStatus(status) {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

async function updateBookingFromPayment(payment, normalizedStatus) {
  if (!payment.booking_reference) {
    return null;
  }

  const booking = await Booking.findOne({ booking_id: payment.booking_reference });

  if (!booking) {
    return null;
  }

  if (normalizedStatus === "COMPLETE") {
    booking.payment_status = "paid";
    if (booking.booking_status === "pending") {
      booking.booking_status = "confirmed";
    }
    booking.transaction_id =
      payment.khaltiTransactionId ||
      payment.transactionUuid ||
      booking.transaction_id;
  } else if (
    normalizedStatus === "PENDING" ||
    normalizedStatus === "INITIATED"
  ) {
    booking.payment_status = "pending";
  } else {
    booking.payment_status = "failed";
    if (booking.booking_status === "pending") {
      booking.booking_status = "canceled";
    }
  }

  await booking.save();
  return booking;
}

// Initiate Khalti payment from the backend using Khalti's server-side
// `/epayment/initiate/` API so the secret key stays off the frontend.
router.post("/khalti/initiate", authenticateAccessToken, async (req, res) => {
  const config = getRequiredKhaltiConfig();
  const missingConfig = validateKhaltiConfig(config);

  if (missingConfig.length > 0) {
    return res.status(500).json({
      flag: "0",
      message: `Missing Khalti configuration: ${missingConfig.join(", ")}`,
    });
  }

  try {
    const bookingReference =
      req.body.bookingId ?? req.body.booking_id ?? req.body.bookingReference;
    const orderReference =
      req.body.orderId ?? req.body.order_id ?? req.body.orderReference;

    if (!bookingReference && !orderReference) {
      return res.status(400).json({
        flag: "0",
        message: "bookingId or orderId is required.",
      });
    }

    let booking = null;

    if (bookingReference) {
      booking = await Booking.findOne({ booking_id: Number(bookingReference) });

      if (!booking) {
        return res.status(404).json({
          flag: "0",
          message: "Booking not found.",
        });
      }
    }

    const requestedAmount =
      normalizeAmount(req.body.amount) ??
      normalizeAmount(booking?.paid_price) ??
      normalizeAmount(booking?.total_price);
    const amountInPaisa = normalizeKhaltiAmountInPaisa(requestedAmount, req.body);

    if (!Number.isInteger(amountInPaisa) || amountInPaisa < 1000) {
      return res.status(400).json({
        flag: "0",
        message:
          "A valid amount is required. Khalti requires at least Rs. 10 (1000 paisa).",
      });
    }

    const purchaseOrderId =
      bookingReference
        ? `BOOKING-${bookingReference}`
        : orderReference
          ? `ORDER-${orderReference}`
          : `PAY-${Date.now()}`;
    const purchaseOrderName =
      req.body.purchase_order_name ||
      req.body.purchaseOrderName ||
      (bookingReference ? `Booking #${bookingReference}` : "Platform Payment");
    const transactionUuid = buildTransactionUuid(purchaseOrderId);
    const returnUrl = `${config.serverBaseUrl}/api/payment/khalti/verify`;

    const payload = {
      return_url: returnUrl,
      website_url: config.websiteUrl,
      amount: amountInPaisa,
      purchase_order_id: purchaseOrderId,
      purchase_order_name: purchaseOrderName,
      customer_info: {
        name: req.body.customer_name || req.body.name || req.auth.name || "Customer",
        email: req.body.customer_email || req.body.email || undefined,
        phone: req.body.customer_phone || req.body.phone || undefined,
      },
    };

    const khaltiResponse = await fetch(
      `${config.gatewayBaseUrl}/epayment/initiate/`,
      {
        method: "POST",
        headers: buildKhaltiHeaders(config.secretKey),
        body: JSON.stringify(payload),
      },
    );

    const responseText = await khaltiResponse.text();
    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch (_error) {
      responseData = { raw: responseText };
    }

    if (!khaltiResponse.ok) {
      return res.status(khaltiResponse.status).json({
        flag: "0",
        message: "Unable to initiate Khalti payment.",
        khalti: responseData,
      });
    }

    const payment = new Payment({
      user_id:
        booking?.user_id && ObjectId.isValid(booking.user_id)
          ? new ObjectId(booking.user_id)
          : ObjectId.isValid(req.auth.id)
            ? new ObjectId(req.auth.id)
            : undefined,
      transaction_id: transactionUuid,
      transactionUuid,
      booking_reference: booking ? booking.booking_id : undefined,
      order_reference: orderReference ? String(orderReference) : undefined,
      amount: amountInPaisa / 100,
      payment_method: "khalti",
      payment_status: "pending",
      khaltiPidx: responseData.pidx,
      additional_details: {
        provider: "khalti",
        initiatedBy: req.auth.id,
        khaltiInitiate: responseData,
        purchase_order_id: purchaseOrderId,
        purchase_order_name: purchaseOrderName,
      },
    });

    await payment.save();

    return res.status(201).json({
      flag: "1",
      message: "Khalti payment initialized successfully.",
      paymentId: payment._id,
      transaction_uuid: transactionUuid,
      purchase_order_id: purchaseOrderId,
      purchase_order_name: purchaseOrderName,
      pidx: responseData.pidx,
      payment_url: responseData.payment_url,
      expires_at: responseData.expires_at,
      expires_in: responseData.expires_in,
      return_url: returnUrl,
    });
  } catch (error) {
    console.error("Error initiating Khalti payment:", error);
    return res.status(500).json({
      flag: "0",
      message: "Unable to initiate Khalti payment.",
    });
  }
});

// Khalti redirects the user to our `return_url` with query params including
// `pidx`; we must confirm the final status via `/epayment/lookup/`.
router.get("/khalti/verify", async (req, res) => {
  const config = getRequiredKhaltiConfig();
  const missingConfig = validateKhaltiConfig(config);

  if (missingConfig.length > 0) {
    return res.status(500).json({
      flag: "0",
      message: `Missing Khalti configuration: ${missingConfig.join(", ")}`,
    });
  }

  const pidx = String(req.query.pidx || "").trim();

  if (!pidx) {
    return res.status(400).json({
      flag: "0",
      message: "pidx is required.",
    });
  }

  try {
    const payment = await Payment.findOne({ khaltiPidx: pidx });

    if (!payment) {
      return res.status(404).json({
        flag: "0",
        message: "Payment record not found.",
      });
    }

    const khaltiResponse = await fetch(
      `${config.gatewayBaseUrl}/epayment/lookup/`,
      {
        method: "POST",
        headers: buildKhaltiHeaders(config.secretKey),
        body: JSON.stringify({ pidx }),
      },
    );

    const responseText = await khaltiResponse.text();
    let lookupData;

    try {
      lookupData = JSON.parse(responseText);
    } catch (_error) {
      lookupData = { raw: responseText };
    }

    if (!khaltiResponse.ok) {
      return res.status(khaltiResponse.status).json({
        flag: "0",
        message: "Unable to verify Khalti payment.",
        khalti: lookupData,
      });
    }

    const normalizedStatus = normalizeKhaltiStatus(lookupData.status);

    if (normalizedStatus === "COMPLETED") {
      payment.payment_status = "paid";
      payment.date_of_payment = new Date();
      payment.paidAt = new Date();
      payment.khaltiTransactionId = lookupData.transaction_id || null;
    } else if (normalizedStatus === "PENDING" || normalizedStatus === "INITIATED") {
      payment.payment_status = "pending";
    } else if (normalizedStatus === "REFUNDED" || normalizedStatus === "PARTIALLY REFUNDED") {
      payment.payment_status = "refunded";
      payment.khaltiTransactionId = lookupData.transaction_id || null;
    } else {
      payment.payment_status = "failed";
    }

    payment.additional_details = {
      ...(payment.additional_details || {}),
      khaltiLookup: lookupData,
      khaltiCallback: req.query,
    };

    await payment.save();
    const booking = await updateBookingFromPayment(
      payment,
      normalizedStatus === "COMPLETED" ? "COMPLETE" : normalizedStatus,
    );

    const responsePayload = {
      flag: normalizedStatus === "COMPLETED" ? "1" : "0",
      message:
        normalizedStatus === "COMPLETED"
          ? "Payment verified successfully."
          : normalizedStatus === "PENDING" || normalizedStatus === "INITIATED"
            ? "Payment is still pending."
            : "Payment verification failed.",
      paymentStatus: payment.payment_status,
      pidx,
      khaltiStatus: lookupData.status || "UNKNOWN",
      transactionId: payment.khaltiTransactionId || null,
      bookingStatus: booking?.booking_status || null,
      verification: lookupData,
    };

    const shouldRedirect =
      req.headers.accept &&
      !req.headers.accept.includes("application/json") &&
      req.query.redirect !== "false";

    if (shouldRedirect) {
      const redirectBase =
        normalizedStatus === "COMPLETED"
          ? config.clientSuccessRedirect
          : config.clientFailureRedirect;
      const redirectUrl = new URL(redirectBase);
      redirectUrl.searchParams.set("pidx", pidx);
      redirectUrl.searchParams.set("paymentStatus", payment.payment_status);
      redirectUrl.searchParams.set("khaltiStatus", lookupData.status || "UNKNOWN");
      if (payment.khaltiTransactionId) {
        redirectUrl.searchParams.set("transactionId", payment.khaltiTransactionId);
      }
      return res.redirect(redirectUrl.toString());
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("Error verifying Khalti payment:", error);
    return res.status(500).json({
      flag: "0",
      message: "Unable to verify Khalti payment.",
    });
  }
});

// 1. Create Payment
router.post("/", async (req, res) => {
  try {
    const { user_id, transaction_id, amount, payment_method, payment_status } =
      req.body;

    // Check if user_id is provided
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    // Validate user_id format
    if (!ObjectId.isValid(user_id)) {
      return res.status(400).json({ error: "Invalid user_id format" });
    }

    const newPayment = new Payment({
      user_id: new ObjectId(user_id),
      transaction_id,
      amount,
      payment_method,
      payment_status,
    });

    await newPayment.save();
    res
      .status(201)
      .json({ message: "Payment created successfully", payment: newPayment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// 2. Get All Payments
router.get("/", async (req, res) => {
  try {
    // Fetch all payments from the Payment collection
    const payments = await Payment.find();

    // If no payments are found, send a 404 response
    if (!payments || payments.length === 0) {
      return res.status(404).json({ message: "No payments found." });
    }

    // For each payment, get the user details
    const paymentsWithUserDetails = await Promise.all(
      payments.map(async (payment) => {
        // Fetch user details using user_id from the payment
        const userDetails = await User.findById(payment.user_id).select(
          "name email mobile"
        );

        return {
          ...payment.toObject(),
          userDetails: userDetails || {},
        };
      })
    );

    // Send the payments data with user details
    res.status(200).json(paymentsWithUserDetails);
  } catch (err) {
    // Catch any errors and return a 500 status with the error message
    console.error("Error fetching payments:", err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Payments by User ID
router.get("/userID", async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res
      .status(400)
      .json({ message: "Missing required query parameter: user_id" });
  }

  try {
    const payments = await Payment.find({ user_id });

    if (!payments.length) {
      return res
        .status(404)
        .json({ message: "No payments found for the specified user" });
    }

    res.status(200).json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Payment by ID
router.get("/:id", async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    res.status(200).json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Payment

router.put("/:id", async (req, res) => {
  try {
    const {
      user_id,
      transaction_id,
      amount,
      payment_method,
      payment_status,
      date_of_payment,
    } = req.body;

    // Validate user_id
    if (user_id && !ObjectId.isValid(user_id)) {
      return res.status(400).json({ error: "Invalid user_id format" });
    }

    // Validate payment_status
    const validStatuses = [
      "pending",
      "success",
      "paid",
      "failed",
      "cancelled",
      "refunded",
    ];
    if (payment_status && !validStatuses.includes(payment_status)) {
      return res.status(400).json({
        error: `Invalid payment_status. Allowed values are: ${validStatuses.join(
          ", "
        )}`,
      });
    }

    const payment = await Payment.findByIdAndUpdate(
      req.params.id,
      {
        user_id: user_id ? new ObjectId(user_id) : undefined, // Convert only if provided
        transaction_id,
        amount,
        payment_method,
        payment_status,
        date_of_payment,
      },
      { new: true, runValidators: true }
    );
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    res.status(200).json({ message: "Payment updated successfully", payment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Delete Payment
router.delete("/:id", async (req, res) => {
  try {
    const payment = await Payment.findByIdAndDelete(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    res.status(200).json({ message: "Payment deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
