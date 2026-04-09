const express = require("express");
const mongoose = require("mongoose");
const Bid = require("../models/BidSchema");
const Users = require("../models/Users");
const Admin = require("../models/Admin");
const CarListing = require("../models/CarListing");
const {
  authenticateAccessToken,
  extractAccessToken,
} = require("../middleware/auth");
const { verifyAccessToken } = require("../utils/token");
const {
  buildBidResponse,
  findListingByIdentifier,
  getListingPrice,
  getVehicleTitle,
  normalizeMode,
  parsePositiveAmount,
  verifyAcceptedBidAccess,
} = require("../utils/bidApproval");

const router = express.Router();
const ALLOW_PUBLIC_ADMIN_BID_READ = process.env.NODE_ENV !== "production";

async function getAuthenticatedUser(req) {
  return Users.findById(req.auth.id).select("user_id name email status");
}

async function populateBid(bidId) {
  return Bid.findById(bidId)
    .populate("user", "user_id name email")
    .populate("listing", "listing_id make model year price RentList");
}

function buildApprovalPayload(bid, fallbackMessage) {
  if (!bid) {
    return {
      approved: false,
      status: null,
      approvedPrice: null,
      bid: null,
      message: fallbackMessage,
    };
  }

  return {
    approved: bid.status === "accepted",
    status: bid.status,
    approvedPrice: bid.status === "accepted" ? bid.approvedPrice : null,
    bid: buildBidResponse(bid),
    message:
      bid.status === "accepted"
        ? "Approved bid found."
        : bid.status === "rejected"
          ? "Your bid was rejected by the admin."
          : "Your bid is still pending admin review.",
  };
}

async function resolveAdminActor(req) {
  const token = extractAccessToken(req);

  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      if (decoded?.role === "admin") {
        const admin = await Admin.findById(decoded.id).select("_id name email role");
        if (admin) {
          req.auth = {
            ...(req.auth || {}),
            id: admin._id.toString(),
            role: "admin",
            email: admin.email,
            accountType: "admin",
          };
          return admin;
        }
      }
    } catch (_error) {
      // Fall back to legacy admin id resolution below.
    }
  }

  const adminId =
    req.headers["x-admin-id"] ||
    req.headers["admin-id"] ||
    req.query.adminId ||
    req.query.admin_id ||
    req.body?.adminId ||
    req.body?.admin_id ||
    null;

  if (!adminId || !mongoose.Types.ObjectId.isValid(String(adminId))) {
    return null;
  }

  const admin = await Admin.findById(adminId).select("_id name email role");
  if (!admin) {
    return null;
  }

  req.auth = {
    ...(req.auth || {}),
    id: admin._id.toString(),
    role: "admin",
    email: admin.email,
    accountType: "admin",
  };

  return admin;
}

async function ensureAdminAccess(req, res) {
  const admin = await resolveAdminActor(req);

  if (!admin) {
    if (ALLOW_PUBLIC_ADMIN_BID_READ && req.method === "GET") {
      return { _id: null, role: "admin", name: "Development Admin" };
    }

    res.status(401).json({
      flag: "0",
      message:
        "Admin authentication is required. Send an admin access token or adminId.",
    });
    return null;
  }

  return admin;
}

function normalizeStatusFilter(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return ["pending", "accepted", "rejected"].includes(normalized)
    ? normalized
    : null;
}

async function fetchBidsForResponse(filter = {}) {
  const bids = await Bid.find(filter).sort({ createdAt: -1 }).lean();

  const userIds = [
    ...new Set(
      bids
        .map((bid) => {
          if (bid.user && mongoose.Types.ObjectId.isValid(String(bid.user))) {
            return String(bid.user);
          }

          if (
            bid.user_id &&
            mongoose.Types.ObjectId.isValid(String(bid.user_id))
          ) {
            return String(bid.user_id);
          }

          return null;
        })
        .filter(Boolean)
    ),
  ];

  const listingObjectIds = [
    ...new Set(
      bids
        .map((bid) => {
          if (
            bid.listing &&
            mongoose.Types.ObjectId.isValid(String(bid.listing))
          ) {
            return String(bid.listing);
          }

          if (
            bid.listing_id &&
            mongoose.Types.ObjectId.isValid(String(bid.listing_id))
          ) {
            return String(bid.listing_id);
          }

          return null;
        })
        .filter(Boolean)
    ),
  ];

  const listingNumbers = [
    ...new Set(
      bids
        .map((bid) =>
          typeof bid.listing_id === "number" ? bid.listing_id : null
        )
        .filter((value) => value !== null)
    ),
  ];

  const [users, listingsByObjectId, listingsByNumber] = await Promise.all([
    userIds.length
      ? Users.find({ _id: { $in: userIds } })
          .select("_id user_id name email")
          .lean()
      : [],
    listingObjectIds.length
      ? CarListing.find({ _id: { $in: listingObjectIds } })
          .select("_id listing_id make model year price RentList")
          .lean()
      : [],
    listingNumbers.length
      ? CarListing.find({ listing_id: { $in: listingNumbers } })
          .select("_id listing_id make model year price RentList")
          .lean()
      : [],
  ]);

  const userMap = new Map(users.map((user) => [String(user._id), user]));
  const listingMapById = new Map(
    listingsByObjectId.map((listing) => [String(listing._id), listing])
  );
  const listingMapByNumber = new Map(
    listingsByNumber.map((listing) => [listing.listing_id, listing])
  );

  return bids.map((bid) => {
    const userRef =
      (bid.user && mongoose.Types.ObjectId.isValid(String(bid.user))
        ? String(bid.user)
        : null) ||
      (bid.user_id && mongoose.Types.ObjectId.isValid(String(bid.user_id))
        ? String(bid.user_id)
        : null);

    const legacyListingRef =
      (bid.listing && mongoose.Types.ObjectId.isValid(String(bid.listing))
        ? String(bid.listing)
        : null) ||
      (bid.listing_id && mongoose.Types.ObjectId.isValid(String(bid.listing_id))
        ? String(bid.listing_id)
        : null);

    const resolvedUser = userRef ? userMap.get(userRef) || null : null;
    const resolvedListing =
      (legacyListingRef ? listingMapById.get(legacyListingRef) || null : null) ||
      (typeof bid.listing_id === "number"
        ? listingMapByNumber.get(bid.listing_id) || null
        : null);

    return {
      ...bid,
      user: resolvedUser || bid.user || null,
      listing: resolvedListing || bid.listing || null,
      userName: bid.userName || resolvedUser?.name || "Unknown User",
      userEmail: bid.userEmail || resolvedUser?.email || null,
      user_id:
        typeof bid.user_id === "string"
          ? bid.user_id
          : resolvedUser?.user_id || bid.user_id || null,
      listing_id:
        typeof bid.listing_id === "number"
          ? bid.listing_id
          : resolvedListing?.listing_id ?? bid.listing_id ?? null,
      vehicleTitle:
        bid.vehicleTitle ||
        (resolvedListing ? getVehicleTitle(resolvedListing) : "Vehicle"),
      listedPrice:
        bid.listedPrice ??
        (resolvedListing ? getListingPrice(resolvedListing) : null),
      mode: bid.mode || "buy",
    };
  });
}

function buildBidCollectionResponse(bids, message = "Bids fetched successfully.") {
  const normalizedBids = bids.map(buildBidResponse);

  return {
    flag: "1",
    message,
    count: normalizedBids.length,
    bids: normalizedBids,
    items: normalizedBids,
    data: normalizedBids,
  };
}

function buildListingIdentifierQuery(identifier) {
  const trimmedIdentifier = String(identifier || "").trim();

  if (!trimmedIdentifier) {
    return null;
  }

  const orConditions = [];

  if (mongoose.Types.ObjectId.isValid(trimmedIdentifier)) {
    orConditions.push({ listing: trimmedIdentifier });
  }

  if (/^\d+$/.test(trimmedIdentifier)) {
    orConditions.push({ listing_id: Number(trimmedIdentifier) });
  }

  return orConditions.length > 0 ? { $or: orConditions } : null;
}

function getBidStatusPriority(status) {
  if (status === "accepted") {
    return 3;
  }

  if (status === "rejected") {
    return 2;
  }

  if (status === "pending") {
    return 1;
  }

  return 0;
}

function selectPreferredBidRecord(bids = []) {
  if (!Array.isArray(bids) || bids.length === 0) {
    return null;
  }

  const sortedBids = [...bids].sort((left, right) => {
    const statusDiff =
      getBidStatusPriority(right.status) - getBidStatusPriority(left.status);

    if (statusDiff !== 0) {
      return statusDiff;
    }

    const rightUpdatedAt = new Date(
      right.decidedAt || right.updatedAt || right.createdAt || 0
    ).getTime();
    const leftUpdatedAt = new Date(
      left.decidedAt || left.updatedAt || left.createdAt || 0
    ).getTime();

    return rightUpdatedAt - leftUpdatedAt;
  });

  return sortedBids[0];
}

async function findUserBidByListingIdentifier({ userId, listingIdentifier, mode }) {
  const normalizedMode = normalizeMode(mode);
  const listing = await findListingByIdentifier(listingIdentifier);

  if (listing) {
    const bids = await Bid.find({
      user: userId,
      listing: listing._id,
      ...(normalizedMode ? { $or: [{ mode: normalizedMode }, { mode: { $exists: false } }] } : {}),
    })
      .populate("user", "user_id name email")
      .populate("listing", "listing_id make model year price RentList")
      .sort({ updatedAt: -1, createdAt: -1 });

    return selectPreferredBidRecord(bids);
  }

  const listingQuery = buildListingIdentifierQuery(listingIdentifier);
  if (!listingQuery) {
    return null;
  }

  const bids = await Bid.find({
    user: userId,
    ...(normalizedMode ? { $or: [{ mode: normalizedMode }, { mode: { $exists: false } }] } : {}),
    ...listingQuery,
  })
    .populate("user", "user_id name email")
    .populate("listing", "listing_id make model year price RentList")
    .sort({ updatedAt: -1, createdAt: -1 });

  return selectPreferredBidRecord(bids);
}

router.post("/bids", authenticateAccessToken, async (req, res) => {
  const listingIdentifier =
    req.body.listingId ?? req.body.listing_id ?? req.body.carId ?? req.body.car_id;
  const mode = normalizeMode(req.body.mode);
  const bidAmount = parsePositiveAmount(req.body.bidAmount ?? req.body.amount);

  if (!listingIdentifier) {
    return res.status(400).json({
      flag: "0",
      message: "listingId is required.",
    });
  }

  if (!mode) {
    return res.status(400).json({
      flag: "0",
      message: 'mode must be either "rent" or "buy".',
    });
  }

  if (!bidAmount) {
    return res.status(400).json({
      flag: "0",
      message: "bidAmount must be a positive number.",
    });
  }

  try {
    const [listing, user] = await Promise.all([
      findListingByIdentifier(listingIdentifier),
      getAuthenticatedUser(req),
    ]);

    if (!listing) {
      return res.status(404).json({
        flag: "0",
        message: "Listing not found.",
      });
    }

    if (!user || user.status !== "active") {
      return res.status(404).json({
        flag: "0",
        message: "User not found or inactive.",
      });
    }

    const listedPrice = getListingPrice(listing);
    if (listedPrice === null) {
      return res.status(400).json({
        flag: "0",
        message: "This listing does not have a valid price for bidding.",
      });
    }

    const existingAcceptedBid = await Bid.findOne({
      user: user._id,
      listing: listing._id,
      mode,
      status: "accepted",
    }).sort({ decidedAt: -1, updatedAt: -1 });

    if (existingAcceptedBid) {
      return res.status(409).json({
        flag: "0",
        message:
          "You already have an accepted bid for this vehicle and mode. Use the approved price to continue.",
        bid: buildBidResponse(existingAcceptedBid),
      });
    }

    const vehicleTitle = getVehicleTitle(listing);
    const update = {
      user: user._id,
      user_id: user.user_id || null,
      userName: user.name,
      userEmail: user.email,
      listing: listing._id,
      listing_id: listing.listing_id ?? null,
      vehicleTitle,
      listedPrice,
      bidAmount,
      approvedPrice: null,
      mode,
      status: "pending",
      adminNote: null,
      decidedBy: null,
      decidedAt: null,
    };

    const bid = await Bid.findOneAndUpdate(
      {
        user: user._id,
        listing: listing._id,
        mode,
        status: "pending",
      },
      {
        $set: update,
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    const populatedBid = await populateBid(bid._id);

    return res.status(201).json({
      flag: "1",
      message: "Bid submitted successfully.",
      bid: buildBidResponse(populatedBid),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        flag: "0",
        message: "You already have a pending bid for this vehicle and mode.",
      });
    }

    console.error("Create or update bid error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to save bid.",
    });
  }
});

router.get("/bids", async (req, res) => {
  try {
    const status = normalizeStatusFilter(req.query.status);
    const filter = {};
    const token = extractAccessToken(req);
    let authenticatedRole = null;
    let authenticatedUserId = null;

    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        authenticatedRole = decoded?.role || null;
        authenticatedUserId = decoded?.id || null;
        req.auth = decoded;
      } catch (_error) {
        authenticatedRole = null;
        authenticatedUserId = null;
      }
    }

    if (status) {
      filter.status = status;
    }

    if (authenticatedRole === "admin") {
      await resolveAdminActor(req);
    } else if (authenticatedUserId) {
      filter.user = authenticatedUserId;
    }

    const bids = await fetchBidsForResponse(filter);

    return res.status(200).json(
      buildBidCollectionResponse(
        bids,
        authenticatedRole === "admin" || !authenticatedUserId
          ? "Admin bids fetched successfully."
          : "Your bids fetched successfully."
      )
    );
  } catch (error) {
    console.error("Fetch bids collection error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch bids.",
    });
  }
});

router.get("/bids/my-bids", authenticateAccessToken, async (req, res) => {
  try {
    const bids = await fetchBidsForResponse({ user: req.auth.id });

    return res
      .status(200)
      .json(buildBidCollectionResponse(bids, "Your bids fetched successfully."));
  } catch (error) {
    console.error("Fetch user bids error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch your bids.",
    });
  }
});

router.get("/bids/approval/:listingId/:mode", authenticateAccessToken, async (req, res) => {
  try {
    const approval = await verifyAcceptedBidAccess({
      userId: req.auth.id,
      listingIdentifier: req.params.listingId,
      mode: req.params.mode,
    });

    if (!approval.ok) {
      const latestBid = await findUserBidByListingIdentifier({
        userId: req.auth.id,
        listingIdentifier: req.params.listingId,
        mode: req.params.mode,
      });

      return res.status(200).json({
        flag: "1",
        ...buildApprovalPayload(latestBid, approval.message),
      });
    }

    const populatedBid = await populateBid(approval.bid._id);
    return res.status(200).json({
      flag: "1",
      ...buildApprovalPayload(populatedBid, "Approved bid found."),
    });
  } catch (error) {
    console.error("Fetch bid approval error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to verify bid approval.",
    });
  }
});

router.get("/bids/:listingId/:mode", authenticateAccessToken, async (req, res) => {
  const mode = normalizeMode(req.params.mode);

  if (!mode) {
    return res.status(400).json({
      flag: "0",
      message: 'mode must be either "rent" or "buy".',
    });
  }

  try {
    const bid = await findUserBidByListingIdentifier({
      userId: req.auth.id,
      listingIdentifier: req.params.listingId,
      mode,
    });

    return res.status(200).json({
      flag: "1",
      bid: buildBidResponse(bid),
    });
  } catch (error) {
    console.error("Fetch current bid error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch bid.",
    });
  }
});

async function handleAdminBidList(req, res) {
  const admin = await ensureAdminAccess(req, res);
  if (!admin) {
    return;
  }

  const filter = {};
  const status = normalizeStatusFilter(req.query.status);

  if (req.query.status && !status) {
    return res.status(400).json({
      flag: "0",
      message: 'status must be "pending", "accepted", or "rejected".',
    });
  }

  if (status) {
    filter.status = status;
  }

  try {
    const bids = await fetchBidsForResponse(filter);

    return res
      .status(200)
      .json(buildBidCollectionResponse(bids, "Admin bids fetched successfully."));
  } catch (error) {
    console.error("Fetch admin bids error:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch bids.",
    });
  }
}

router.get("/admin/bids", handleAdminBidList);
router.get("/admin/bids/all", handleAdminBidList);

router.get("/bids/admin", handleAdminBidList);
router.get("/bids/admin/all", handleAdminBidList);
router.get("/bids/all", handleAdminBidList);

async function handleBidDecision(req, res, nextStatus) {
  const admin = await ensureAdminAccess(req, res);
  if (!admin) {
    return;
  }

  const adminNote =
    req.body.adminNote === undefined || req.body.adminNote === null
      ? null
      : String(req.body.adminNote).trim();

  if (!mongoose.Types.ObjectId.isValid(req.params.bidId)) {
    return res.status(400).json({
      flag: "0",
      message: "Invalid bid id.",
    });
  }

  try {
    const bid = await Bid.findById(req.params.bidId);
    if (!bid) {
      return res.status(404).json({
        flag: "0",
        message: "Bid not found.",
      });
    }

    if (bid.status !== "pending") {
      return res.status(409).json({
        flag: "0",
        message: "Only pending bids can be decided.",
      });
    }

    bid.status = nextStatus;
    bid.approvedPrice = nextStatus === "accepted" ? bid.bidAmount : null;
    bid.adminNote = adminNote;
    bid.decidedBy = admin._id;
    bid.decidedAt = new Date();
    await bid.save();

    if (nextStatus === "accepted") {
      await Bid.updateMany(
        {
          _id: { $ne: bid._id },
          $or: [
            { user: bid.user, listing: bid.listing, mode: bid.mode },
            {
              user_id: bid.user_id || null,
              listing_id: bid.listing_id || null,
              mode: bid.mode,
            },
          ],
          status: "pending",
        },
        {
          $set: {
            status: "rejected",
            adminNote:
              adminNote ||
              "Another bid for this vehicle and mode was accepted.",
            decidedBy: admin._id,
            decidedAt: new Date(),
            approvedPrice: null,
          },
        }
      );
    }

    const populatedBid = await populateBid(bid._id);

    return res.status(200).json({
      flag: "1",
      message:
        nextStatus === "accepted"
          ? "Bid accepted successfully."
          : "Bid rejected successfully.",
      bid: buildBidResponse(populatedBid),
    });
  } catch (error) {
    console.error(`Bid ${nextStatus} error:`, error);
    return res.status(500).json({
      flag: "0",
      message: `Failed to ${nextStatus} bid.`,
    });
  }
}

router.patch(
  "/admin/bids/:bidId/accept",
  async (req, res) => handleBidDecision(req, res, "accepted")
);

router.patch(
  "/admin/bids/:bidId/reject",
  async (req, res) => handleBidDecision(req, res, "rejected")
);

router.patch(
  "/bids/:bidId/status",
  async (req, res) => {
    const requestedStatus = String(req.body.status || "")
      .trim()
      .toLowerCase();

    if (!["accepted", "rejected"].includes(requestedStatus)) {
      return res.status(400).json({
        flag: "0",
        message: 'status must be either "accepted" or "rejected".',
      });
    }

    return handleBidDecision(req, res, requestedStatus);
  }
);

module.exports = router;
