const express = require("express");
const mongoose = require("mongoose");
const ContactMessage = require("../models/ContactMessage");
const { sendMail, resolveSupportEmail } = require("../utils/mail");
const { authenticateAccessToken, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function normalizeField(value) {
  return String(value || "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function serializeContactMessage(contactMessage) {
  return {
    _id: contactMessage._id,
    id: contactMessage._id,
    name: contactMessage.name,
    email: contactMessage.email,
    subject: contactMessage.subject,
    message: contactMessage.message,
    status: contactMessage.status,
    emailSent: contactMessage.emailSent,
    emailSentAt: contactMessage.emailSentAt,
    adminNotes: contactMessage.adminNotes || "",
    createdAt: contactMessage.createdAt,
    updatedAt: contactMessage.updatedAt,
  };
}

router.post("/contact", async (req, res) => {
  const name = normalizeField(req.body.name);
  const email = normalizeField(req.body.email).toLowerCase();
  const subject = normalizeField(req.body.subject);
  const message = normalizeField(req.body.message);

  if (!name || !email || !subject || !message) {
    return res.status(400).json({
      flag: "0",
      message: "Name, email, subject, and message are required.",
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      flag: "0",
      message: "A valid email address is required.",
    });
  }

  try {
    const contactMessage = await ContactMessage.create({
      name,
      email,
      subject,
      message,
    });

    const supportEmail = resolveSupportEmail();

    if (supportEmail) {
      try {
        await sendMail({
          to: supportEmail,
          replyTo: email,
          subject: `Contact Us: ${subject}`,
          text: [
            `Name: ${name}`,
            `Email: ${email}`,
            `Subject: ${subject}`,
            "",
            message,
          ].join("\n"),
          html: `
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, "<br />")}</p>
          `,
        });

        contactMessage.emailSent = true;
        contactMessage.emailSentAt = new Date();
        await contactMessage.save();
      } catch (mailError) {
        console.error("Failed to send contact email, but message was saved for admin inbox:", mailError);
      }
    } else {
      console.warn("SUPPORT_EMAIL/MAIL_FROM not configured. Contact message saved to admin inbox only.");
    }

    return res.status(201).json({
      flag: "1",
      message: "Contact message sent successfully.",
      contactMessage: serializeContactMessage(contactMessage),
    });
  } catch (error) {
    console.error("Contact message error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to process contact message.",
    });
  }
});

router.get("/contact/admin", authenticateAccessToken, requireAdmin, async (_req, res) => {
  try {
    const contactMessages = await ContactMessage.find().sort({
      createdAt: -1,
      updatedAt: -1,
    });

    return res.status(200).json({
      flag: "1",
      messages: contactMessages.map(serializeContactMessage),
    });
  } catch (error) {
    console.error("Failed to fetch contact admin inbox:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch contact messages.",
    });
  }
});

router.get("/contact/admin/:id", authenticateAccessToken, requireAdmin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ flag: "0", message: "Invalid message id." });
  }

  try {
    const contactMessage = await ContactMessage.findById(req.params.id);

    if (!contactMessage) {
      return res.status(404).json({ flag: "0", message: "Message not found." });
    }

    if (contactMessage.status === "new") {
      contactMessage.status = "read";
      await contactMessage.save();
    }

    return res.status(200).json({
      flag: "1",
      message: serializeContactMessage(contactMessage),
    });
  } catch (error) {
    console.error("Failed to fetch contact message:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch contact message.",
    });
  }
});

router.patch("/contact/admin/:id", authenticateAccessToken, requireAdmin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ flag: "0", message: "Invalid message id." });
  }

  const status =
    req.body.status === undefined ? undefined : String(req.body.status).trim().toLowerCase();
  const adminNotes =
    req.body.adminNotes === undefined ? undefined : String(req.body.adminNotes).trim();

  if (status !== undefined && !["new", "read", "replied"].includes(status)) {
    return res.status(400).json({
      flag: "0",
      message: "Status must be one of: new, read, replied.",
    });
  }

  try {
    const contactMessage = await ContactMessage.findById(req.params.id);

    if (!contactMessage) {
      return res.status(404).json({ flag: "0", message: "Message not found." });
    }

    if (status !== undefined) {
      contactMessage.status = status;
    }

    if (adminNotes !== undefined) {
      contactMessage.adminNotes = adminNotes;
    }

    await contactMessage.save();

    return res.status(200).json({
      flag: "1",
      message: "Contact message updated successfully.",
      contactMessage: serializeContactMessage(contactMessage),
    });
  } catch (error) {
    console.error("Failed to update contact message:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to update contact message.",
    });
  }
});

module.exports = router;
