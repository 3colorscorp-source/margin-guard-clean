/**
 * In-process simulator of public.mg_support_transition_case.
 * Used by Support tests only. Does not contact Supabase or send email.
 */
"use strict";

const TO_STATUS = {
  mark_in_review: "in_review",
  request_customer_action: "waiting_on_customer",
  resolve: "resolved",
  reopen: "open",
  return_to_open: "open",
};

const EVENT_TYPE = {
  mark_in_review: "case_in_review",
  request_customer_action: "case_waiting_on_customer",
  resolve: "case_resolved",
  reopen: "case_reopened",
  return_to_open: null,
};

const FROM_OK = {
  mark_in_review: { open: true, waiting_on_customer: true, resolved: true },
  request_customer_action: { open: true, in_review: true },
  resolve: { open: true, in_review: true, waiting_on_customer: true },
  reopen: { resolved: true },
  return_to_open: { in_review: true },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function payload(code, extra) {
  return Object.assign(
    {
      result_code: code,
      case_id: null,
      status: null,
      status_version: null,
      event_queued: false,
      event_id: null,
    },
    extra || {}
  );
}

function eventKey(row) {
  return String(row.case_id) + "|" + String(row.case_status_version) + "|" + String(row.event_type);
}

function applyTransitionRpc(stored, events, args, stamp, options) {
  const opts = options || {};
  const action = args && args.p_action;
  const caseId = args && args.p_case_id;
  const expectedStatus = args && args.p_expected_status;
  const expectedVersion = args && args.p_expected_status_version;
  const toStatus = TO_STATUS[action];
  const eventType = Object.prototype.hasOwnProperty.call(EVENT_TYPE, action) ? EVENT_TYPE[action] : undefined;

  if (
    !caseId ||
    expectedStatus == null ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !action ||
    eventType === undefined
  ) {
    return { payload: payload("invalid_request", { case_id: caseId || null }), nextCase: stored, events };
  }

  if (expectedStatus === toStatus) {
    return {
      payload: payload("already_target_state", {
        case_id: caseId,
        status: stored.status || expectedStatus,
        status_version: stored.status_version == null ? expectedVersion : stored.status_version,
        resolved_at: stored.resolved_at == null ? null : stored.resolved_at,
        updated_at: stored.updated_at == null ? null : stored.updated_at,
        customer_resolution: stored.customer_resolution == null ? null : stored.customer_resolution,
        tenant_action_message: stored.tenant_action_message == null ? null : stored.tenant_action_message,
        event_queued: false,
        event_id: null,
      }),
      nextCase: stored,
      events,
    };
  }

  if (!FROM_OK[action] || !FROM_OK[action][expectedStatus]) {
    return {
      payload: payload("invalid_transition", {
        case_id: caseId,
        status: expectedStatus,
        status_version: expectedVersion,
      }),
      nextCase: stored,
      events,
    };
  }

  if (action === "request_customer_action") {
    const msg = String(args.p_tenant_action_message == null ? "" : args.p_tenant_action_message).trim();
    if (!msg || msg.length > 400) {
      return {
        payload: payload("invalid_request", {
          case_id: caseId,
          status: expectedStatus,
          status_version: expectedVersion,
        }),
        nextCase: stored,
        events,
      };
    }
  }

  if (args.p_has_customer_resolution === true && action === "resolve") {
    const text = args.p_customer_resolution == null ? "" : String(args.p_customer_resolution).trim();
    if (!text || text.length > 400) {
      return {
        payload: payload("invalid_request", {
          case_id: caseId,
          status: expectedStatus,
          status_version: expectedVersion,
        }),
        nextCase: stored,
        events,
      };
    }
  }

  if (
    stored.id !== caseId ||
    stored.status !== expectedStatus ||
    stored.status_version !== expectedVersion
  ) {
    return {
      payload: payload("stale_state", {
        case_id: stored.id || caseId,
        status: stored.status == null ? null : stored.status,
        status_version: stored.status_version == null ? null : stored.status_version,
        resolved_at: stored.resolved_at == null ? null : stored.resolved_at,
        updated_at: stored.updated_at == null ? null : stored.updated_at,
        customer_resolution: stored.customer_resolution == null ? null : stored.customer_resolution,
        tenant_action_message: stored.tenant_action_message == null ? null : stored.tenant_action_message,
      }),
      nextCase: stored,
      events,
    };
  }

  const nextCase = clone(stored);
  nextCase.status = toStatus;
  nextCase.status_version = stored.status_version + 1;
  nextCase.updated_at = stamp;
  if (action === "request_customer_action") {
    nextCase.tenant_action_message = String(args.p_tenant_action_message).trim();
    nextCase.resolved_at = null;
  } else if (action === "resolve") {
    nextCase.tenant_action_message = null;
    nextCase.resolved_at = stamp;
    if (args.p_has_customer_resolution === true) {
      nextCase.customer_resolution = args.p_customer_resolution;
    }
  } else {
    nextCase.tenant_action_message = null;
    nextCase.resolved_at = null;
  }

  const nextEvents = events.slice();
  let eventId = null;
  if (eventType) {
    if (opts.failOutbox) {
      const err = new Error("outbox_insert_failed");
      err.code = "outbox_insert_failed";
      throw err;
    }
    const row = {
      id: opts.nextEventId || "eeeeeeee-eeee-4eee-8eee-" + String(nextEvents.length + 1).padStart(12, "0"),
      tenant_id: nextCase.tenant_id,
      case_id: nextCase.id,
      event_type: eventType,
      from_status: expectedStatus,
      to_status: nextCase.status,
      case_status_version: nextCase.status_version,
      payload_version: 1,
      delivery_status: "pending",
      attempt_count: 0,
    };
    const existing = nextEvents.find((item) => eventKey(item) === eventKey(row));
    if (existing) {
      eventId = existing.id;
    } else {
      nextEvents.push(row);
      eventId = row.id;
    }
  }

  return {
    payload: payload("transitioned", {
      case_id: nextCase.id,
      status: nextCase.status,
      status_version: nextCase.status_version,
      resolved_at: nextCase.resolved_at,
      updated_at: nextCase.updated_at,
      customer_resolution: nextCase.customer_resolution == null ? null : nextCase.customer_resolution,
      tenant_action_message: nextCase.tenant_action_message == null ? null : nextCase.tenant_action_message,
      event_queued: eventType != null,
      event_id: eventId,
    }),
    nextCase,
    events: nextEvents,
  };
}

function createTransactionalStore(initialCase, opts) {
  const options = opts || {};
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => "2026-08-28T23:30:00.000Z";
  let stored = clone(initialCase);
  let events = Array.isArray(options.events) ? options.events.map(clone) : [];
  const calls = [];
  const patches = [];

  async function supabaseRpc(name, args) {
    calls.push({ name, args: Object.assign({}, args) });
    if (options.rpcThrow) throw new Error("db");
    if (name !== "mg_support_transition_case") throw new Error("unknown rpc");
    const snapshotCase = clone(stored);
    const snapshotEvents = events.map(clone);
    try {
      const applied = applyTransitionRpc(stored, events, args, nowIso(), options);
      stored = applied.nextCase;
      events = applied.events;
      return applied.payload;
    } catch (err) {
      stored = snapshotCase;
      events = snapshotEvents;
      throw err;
    }
  }

  return {
    supabaseRpc,
    supabaseGet: options.supabaseGet,
    calls,
    rpcs: calls,
    patches,
    events,
    getEvents: () => events.map(clone),
    getStored: () => clone(stored),
    setStored: (row) => {
      stored = clone(row);
    },
    seedEvent: (row) => {
      events.push(clone(row));
    },
  };
}

function createStatelessRpc(options) {
  const opts = options || {};
  const nowIso = typeof opts.nowIso === "function" ? opts.nowIso : () => "2026-08-28T23:30:00.000Z";
  const calls = [];
  const patches = [];
  async function supabaseRpc(name, args) {
    calls.push({ name, args: Object.assign({}, args) });
    if (opts.rpcThrow) throw new Error("db");
    if (opts.rpcStale) {
      return payload("stale_state", {
        case_id: args.p_case_id,
        status: opts.currentStatus || "open",
        status_version: opts.statusVersion == null ? 1 : opts.statusVersion,
      });
    }
    const stored = {
      id: args.p_case_id,
      tenant_id: opts.tenantId || "11111111-1111-4111-8111-111111111111",
      status: args.p_expected_status,
      status_version: args.p_expected_status_version,
      customer_resolution: opts.customerResolution == null ? null : opts.customerResolution,
      tenant_action_message: opts.tenantActionMessage == null ? null : opts.tenantActionMessage,
      resolved_at: opts.resolvedAt == null ? null : opts.resolvedAt,
      updated_at: null,
    };
    const applied = applyTransitionRpc(stored, [], args, nowIso(), opts);
    return applied.payload;
  }
  return { supabaseRpc, calls, rpcs: calls, patches };
}

module.exports = {
  TO_STATUS,
  EVENT_TYPE,
  FROM_OK,
  applyTransitionRpc,
  createTransactionalStore,
  createStatelessRpc,
};
