import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { DURATIONS, TICKET_STATUS, WAITING_LIST_STATUS } from "./constants";
import { internal } from "./_generated/api";

export const updateEvent = mutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    description: v.string(),
    location: v.string(),
    eventDate: v.number(),
    price: v.number(),
    totalTickets: v.number(),
  },
  handler: async (ctx, args) => {
    const { eventId, ...updates } = args;

    // Get current event to check tickets sold
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found");

    const soldTickets = await ctx.db
      .query("tickets")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .filter((q) =>
        q.or(q.eq(q.field("status"), "valid"), q.eq(q.field("status"), "used"))
      )
      .collect();

    // Ensure new total tickets is not less than sold tickets
    if (updates.totalTickets < soldTickets.length) {
      throw new Error(
        `Cannot reduce total tickets below ${soldTickets.length} (number of tickets already sold)`
      );
    }

    await ctx.db.patch(eventId, updates);
    return eventId;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    location: v.string(),
    eventDate: v.number(), // Store as timestamp
    price: v.number(),
    totalTickets: v.number(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("events", {
      name: args.name,
      description: args.description,
      location: args.location,
      eventDate: args.eventDate,
      price: args.price,
      totalTickets: args.totalTickets,
      userId: args.userId,
    });
    return eventId;
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("events")
      .filter((q) => q.eq(q.field("is_cancelled"), undefined))
      .collect();
  },
});

export const getById = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db.get(eventId);
  },
});

export const getEventAvailability = query({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found");

    const purchasedCount = await ctx.db
      .query("tickets")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect()
      .then(
        (ticket) =>
          ticket.filter(
            (t) =>
              t.status === TICKET_STATUS.VALID ||
              t.status === TICKET_STATUS.USED
          ).length
      );

    // count current valid offers
    const now = Date.now();
    const activeOffers = await ctx.db
      .query("waitingList")
      .withIndex("by_event_status", (q) =>
        q.eq("eventId", eventId).eq("status", WAITING_LIST_STATUS.OFFERED)
      )
      .collect()
      .then(
        (entries) => entries.filter((e) => e.offerExpiresAt ?? 0 > now).length
      );

    const totalReserved = purchasedCount + activeOffers;

    return {
      isSoldOut: totalReserved >= event.totalTickets,
      totalTickets: event.totalTickets,
      purchasedCount,
      activeOffers,
      remainingTickets: Math.max(0, event.totalTickets - totalReserved),
    };
  },
});

// Helper function
export const checkAvailability = query({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found");

    // Count total purchased tickets
    const purchasedCount = await ctx.db
      .query("tickets")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect()
      .then(
        (ticket) =>
          ticket.filter(
            (t) =>
              t.status === TICKET_STATUS.VALID ||
              t.status === TICKET_STATUS.USED
          ).length
      );

    // count current valid offers
    const now = Date.now();
    const activeOffers = await ctx.db
      .query("waitingList")
      .withIndex("by_event_status", (q) => q.eq("eventId", eventId))
      .collect()
      .then(
        (entries) => entries.filter((e) => e.offerExpiresAt ?? 0 > now).length
      );

    const availableSpot = event.totalTickets - (purchasedCount + activeOffers);

    return {
      available: availableSpot > 0,
      availableSpot,
      totalTickets: event.totalTickets,
      purchasedCount,
      activeOffers,
    };
  },
});

// Join waiting list for an event
export const joinWaitingList = mutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
  },
  handler: async (ctx, { eventId, userId }) => {
    // Rate limit check
    // const status = await rateLimiter.limit(ctx, "queueJoin", { key: userId });
    // if (!status.ok) {
    //   throw new ConvexError(
    //     `You've joined the waiting list too many times. Please wait ${Math.ceil(
    //       status.retryAfter / (60 * 1000)
    //     )} minutes before trying again.`
    //   );
    // }

    // First check if user is already in the waiting list
    // Active means any status except EXPIRED
    const existingEntry = await ctx.db
      .query("waitingList")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventId", eventId)
      )
      .filter((q) => q.neq(q.field("status"), WAITING_LIST_STATUS.EXPIRED))
      .first();

    // Don't add user if they're already in the waiting list
    if (existingEntry) {
      throw new Error("Already in waiting list for this event.");
    }

    // Verify the event exists
    const event = await ctx.db.get(eventId);
    if (!event) {
      throw new Error("Event not found");
    }

    // Check there any available tickets now
    const { available } = await checkAvailability(ctx, { eventId });

    const now = Date.now();

    if (available) {
      // if there are available tickets, add the user to the waiting list
      const waitingListId = await ctx.db.insert("waitingList", {
        userId,
        eventId,
        status: WAITING_LIST_STATUS.OFFERED,
        offerExpiresAt: now + DURATIONS.TICKET_OFFER,
      });
      // Schedule a job to expire the offer after the offerExpiresAt timestamp
      await ctx.scheduler.runAfter(
        DURATIONS.TICKET_OFFER,
        internal.waitingList.expireOffer,
        { waitingListId, eventId }
      );
    } else {
      // if there are no available tickets, add the user to the waiting list
      await ctx.db.insert("waitingList", {
        userId,
        eventId,
        status: WAITING_LIST_STATUS.WAITING,
      });
    }

    return {
      success: true,
      status: available
        ? WAITING_LIST_STATUS.OFFERED
        : WAITING_LIST_STATUS.WAITING,
      message: available
        ? `Ticket offered - you have ${DURATIONS.TICKET_OFFER / (1000 * 60)} minutes to purchase`
        : "Added to waiting list - you will be notified when a ticket is available",
    };
  },
});
