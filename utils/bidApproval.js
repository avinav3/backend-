const mongoose = require("mongoose");
const Bid = require("../models/BidSchema");
const CarListing = require("../models/CarListing");

function normalizeMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (["rent", "rental"].includes(normalized)) {
    return "rent";
  }

  if (["buy", "list", "sale"].includes(normalized)) {
    return "buy";
  }

  return null;
}

function parsePositiveAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return null;
  }

  return parsedValue;
}

function getListingPrice(listing) {
  if (!listing) {
    return null;
  }

  if (typeof listing.price?.toString === "function") {
    const numericPrice = Number(listing.price.toString());
    return Number.isFinite(numericPrice) ? numericPrice : null;
  }

  const numericPrice = Number(listing.price);
  return Number.isFinite(numericPrice) ? numericPrice : null;
}

function getVehicleTitle(listing) {
  if (!listing) {
    return "Vehicle";
  }

  const titleParts = [listing.year, listing.make, listing.model]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);

  if (titleParts.length > 0) {
    return titleParts.join(" ");
  }

  return listing.title || listing.name || `Listing #${listing.listing_id || listing._id}`;
}

async function findListingByIdentifier(identifier) {
  const trimmedIdentifier = String(identifier || "").trim();

  if (!trimmedIdentifier) {
    return null;
  }

  if (mongoose.Types.ObjectId.isValid(trimmedIdentifier)) {
    const listingByObjectId = await CarListing.findById(trimmedIdentifier);
    if (listingByObjectId) {
      return listingByObjectId;
    }
  }

  if (/^\d+$/.test(trimmedIdentifier)) {
    return CarListing.findOne({ listing_id: Number(trimmedIdentifier) });
  }

  return null;
}

function buildBidResponse(bid) {
  if (!bid) {
    return null;
  }

  const listingDoc =
    bid.listing &&
    typeof bid.listing === "object" &&
    ("listing_id" in bid.listing || "make" in bid.listing || "model" in bid.listing)
      ? bid.listing
      : null;
  const userDoc =
    bid.user &&
    typeof bid.user === "object" &&
    ("name" in bid.user || "email" in bid.user || "user_id" in bid.user)
      ? bid.user
      : null;

  return {
    id: bid._id,
    _id: bid._id,
    user: userDoc
      ? {
          _id: userDoc._id,
          user_id: userDoc.user_id || bid.user_id || null,
          name: userDoc.name || bid.userName,
          email: userDoc.email || bid.userEmail,
        }
      : {
          _id: bid.user,
          user_id: bid.user_id || null,
          name: bid.userName,
          email: bid.userEmail,
        },
    userId: userDoc?._id || bid.user,
    listing: listingDoc
      ? {
          _id: listingDoc._id,
          listing_id: listingDoc.listing_id ?? bid.listing_id ?? null,
          make: listingDoc.make || null,
          model: listingDoc.model || null,
          year: listingDoc.year || null,
          title: bid.vehicleTitle,
          price: getListingPrice(listingDoc) ?? bid.listedPrice,
          RentList: listingDoc.RentList || null,
        }
      : {
          _id: bid.listing,
          listing_id: bid.listing_id ?? null,
          title: bid.vehicleTitle,
          price: bid.listedPrice,
        },
    listingId: listingDoc?._id || bid.listing,
    vehicleTitle: bid.vehicleTitle,
    title: bid.vehicleTitle,
    listedPrice: bid.listedPrice,
    originalPrice: bid.listedPrice,
    bidAmount: bid.bidAmount,
    amount: bid.bidAmount,
    approvedPrice: bid.approvedPrice,
    mode: bid.mode,
    status: bid.status,
    adminNote: bid.adminNote,
    userName: userDoc?.name || bid.userName || "Unknown User",
    userEmail: userDoc?.email || bid.userEmail || null,
    listingNumericId: listingDoc?.listing_id ?? bid.listing_id ?? null,
    difference:
      bid.listedPrice !== null &&
      bid.listedPrice !== undefined &&
      bid.bidAmount !== null &&
      bid.bidAmount !== undefined
        ? Number(bid.bidAmount) - Number(bid.listedPrice)
        : null,
    decidedBy: bid.decidedBy || null,
    decidedAt: bid.decidedAt,
    createdAt: bid.createdAt,
    updatedAt: bid.updatedAt,
  };
}

async function findAcceptedBidForUser({ userId, listingId, mode }) {
  return Bid.findOne({
    user: userId,
    listing: listingId,
    mode,
    status: "accepted",
  }).sort({ decidedAt: -1, updatedAt: -1, createdAt: -1 });
}

async function verifyAcceptedBidAccess({
  userId,
  listingIdentifier,
  mode,
  expectedAmount,
}) {
  const normalizedMode = normalizeMode(mode);

  if (!userId) {
    return {
      ok: false,
      statusCode: 401,
      message: "Authentication is required for bid verification.",
    };
  }

  if (!normalizedMode) {
    return {
      ok: false,
      statusCode: 400,
      message: 'mode must be either "rent" or "buy".',
    };
  }

  const listing = await findListingByIdentifier(listingIdentifier);
  if (!listing) {
    return {
      ok: false,
      statusCode: 404,
      message: "Listing not found.",
    };
  }

  const acceptedBid = await findAcceptedBidForUser({
    userId,
    listingId: listing._id,
    mode: normalizedMode,
  });

  if (!acceptedBid) {
    return {
      ok: false,
      statusCode: 403,
      message: "You do not have an accepted bid for this vehicle and mode.",
      listing,
    };
  }

  if (
    expectedAmount !== undefined &&
    expectedAmount !== null &&
    Number(acceptedBid.approvedPrice) !== Number(expectedAmount)
  ) {
    return {
      ok: false,
      statusCode: 409,
      message: "The requested bid price does not match the approved bid price.",
      listing,
      bid: acceptedBid,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    listing,
    bid: acceptedBid,
  };
}

function extractBidIntentFromPayload(payload = {}) {
  const useBidFlag = payload.useBid ?? payload.bidFlow ?? payload.isBidFlow ?? payload.useApprovedBid;
  const pricingType = String(payload.pricingType || payload.priceSource || payload.checkoutType || "")
    .trim()
    .toLowerCase();
  const normalizedMode = normalizeMode(payload.mode || payload.purpose);
  const requestedPrice =
    parsePositiveAmount(payload.approvedPrice) ??
    parsePositiveAmount(payload.bidAmount) ??
    parsePositiveAmount(payload.total_price) ??
    parsePositiveAmount(payload.amount);

  const listingIdentifier =
    payload.listingId ??
    payload.listing_id ??
    payload.carId ??
    payload.car_id ??
    null;

  const wantsBidValidation =
    useBidFlag === true ||
    useBidFlag === "true" ||
    pricingType === "bid" ||
    pricingType === "bidding" ||
    pricingType === "approved_bid";

  return {
    wantsBidValidation,
    listingIdentifier,
    mode: normalizedMode,
    requestedPrice,
  };
}

module.exports = {
  buildBidResponse,
  extractBidIntentFromPayload,
  findAcceptedBidForUser,
  findListingByIdentifier,
  getListingPrice,
  getVehicleTitle,
  normalizeMode,
  parsePositiveAmount,
  verifyAcceptedBidAccess,
};
