// Supabase Edge Function: capture-lead
// Generic lead capture endpoint used by client websites.
// Reads client_id from the payload and routes to the correct client.
//
// Deploy: supabase functions deploy capture-lead --no-verify-jwt
// URL:    https://bnkoqybkmwtrlorhowyv.supabase.co/functions/v1/capture-lead

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const clientSlug = body.client_id || body.clientId;
    if (!clientSlug) {
      return new Response(JSON.stringify({ error: "client_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve slug to UUID (accept either slug or UUID)
    let clientId = clientSlug;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(clientSlug)) {
      // Try slug lookup (supports both 'islay-studios' and 'islay_studios')
      const normalizedSlug = clientSlug.replace(/_/g, "-");
      const { data: client } = await supabase
        .from("clients").select("id").eq("slug", normalizedSlug).single();
      if (!client) {
        return new Response(JSON.stringify({ error: "Unknown client: " + clientSlug }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      clientId = client.id;
    }

    let rawPhone: string | null =
      body.phone || body.phone_number || body.phoneNumber || null;
    if (rawPhone) {
      rawPhone = rawPhone.replace(/[\s\-().]/g, "");
      if (!rawPhone.startsWith("+")) rawPhone = "+1" + rawPhone;
    }

    const fullName = body.full_name || body.fullName || body.name || null;
    const lead = {
      name: fullName || "Unknown",
      full_name: fullName,
      phone: rawPhone,
      email: body.email || null,
      source: body.lead_source || body.leadSource || body.source || "website",
      lead_source: body.lead_source || body.leadSource || body.source || "website",
      artist_selected: body.artist_selected || body.artistSelected || body.matched_artist || body.artist || null,
      promo_code: body.promo_code || body.promoCode || null,
      booking_url: body.booking_url || body.bookingUrl || null,
      notes: body.notes || null,
      client_id: clientId,
      lead_status: "New",
      date_entered: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("leads")
      .insert(lead)
      .select()
      .single();

    if (error) {
      console.error("Lead insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------------------------------
    // Welcome SMS path.
    //
    // Mirrors lib/welcome.js → sendWelcomeForEvent(): upsert a contact,
    // consume credits atomically, send via Twilio, log the outbound row
    // into `messages` + `credit_ledger` so the portal's Messages tab can
    // actually display the conversation (the whole reason this function
    // exists — other clients go through api/events → sendWelcomeForEvent
    // and get proper message logging, but site-embedded landing pages
    // call capture-lead directly and previously skipped that logging).
    // Refunds credits if Twilio rejects the send.
    // ------------------------------------------------------------------
    let smsDelivered = false;
    let smsStatus: string | null = null;

    if (lead.phone) {
      const { data: client } = await supabase
        .from("clients")
        .select("id, credit_balance, welcome_sms_enabled, welcome_sms_template, twilio_phone_number, name")
        .eq("id", clientId)
        .single();

      const canSend = client?.welcome_sms_enabled &&
                      client.twilio_phone_number &&
                      client.welcome_sms_template;

      if (canSend) {
        // 1) Upsert the contact so the welcome shows up in a Messages thread
        let contactId: string | null = null;
        try {
          const { data: existingContact } = await supabase
            .from("contacts")
            .select("id, opted_out")
            .eq("client_id", clientId)
            .eq("phone", lead.phone)
            .maybeSingle();

          if (existingContact) {
            if (existingContact.opted_out) {
              console.log("capture-lead: contact opted out, skipping welcome SMS");
            } else {
              contactId = existingContact.id;
            }
          } else {
            const { data: newContact, error: cErr } = await supabase
              .from("contacts")
              .insert({
                client_id: clientId,
                phone: lead.phone,
                name: lead.full_name || lead.name || null,
                email: lead.email || null,
                source: lead.source || null,
              })
              .select("id")
              .single();
            if (cErr) {
              console.error("contact upsert error:", cErr);
            } else {
              contactId = newContact?.id || null;
            }
          }
        } catch (err) {
          console.error("contact upsert threw:", err);
        }

        if (contactId) {
          // 2) Render the welcome template
          const fullName = lead.full_name || lead.name || "";
          const firstNameVal = fullName ? fullName.trim().split(/\s+/)[0] : "there";
          const body = String(client.welcome_sms_template || "")
            .replace(/\{\{\s*first_name\s*\}\}/g, firstNameVal)
            .replace(/\{\{\s*name\s*\}\}/g, fullName)
            .replace(/\{\{\s*client_name\s*\}\}/g, client.name || "")
            .replace(/\{\{\s*source\s*\}\}/g, lead.source || "")
            .replace(/\s+/g, " ")
            .trim();

          // 3) Segment estimate — GSM-7 default, 160 chars/segment
          const segments = Math.max(1, Math.ceil(body.length / 160));

          // 4) Credit check
          if ((client.credit_balance ?? 0) < segments) {
            console.log(`capture-lead: insufficient credits (${client.credit_balance ?? 0} < ${segments})`);
          } else {
            // 5) Atomic deduct via RPC (same helper sendWelcomeForEvent uses)
            const { error: dErr } = await supabase.rpc("consume_credits", {
              p_client_id: clientId,
              p_amount: segments,
            });

            if (dErr) {
              console.error("consume_credits failed:", dErr);
            } else {
              // 6) Send via Twilio
              const tsid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
              const ttoken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
              const auth = btoa(`${tsid}:${ttoken}`);
              const params = new URLSearchParams();
              params.set("To", lead.phone);
              params.set("From", client.twilio_phone_number);
              params.set("Body", body);

              let twilioSid: string | null = null;
              try {
                const twilioRes = await fetch(
                  `https://api.twilio.com/2010-04-01/Accounts/${tsid}/Messages.json`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${auth}`,
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: params.toString(),
                  },
                );

                if (twilioRes.ok) {
                  const twilioBody = await twilioRes.json();
                  twilioSid = twilioBody.sid || null;
                  smsStatus = twilioBody.status || "sent";
                  smsDelivered = true;
                } else {
                  const errText = await twilioRes.text();
                  console.error("Twilio HTTP " + twilioRes.status + ":", errText);
                }
              } catch (err) {
                console.error("Twilio fetch threw:", err);
              }

              if (smsDelivered) {
                // 7a) Log the outbound message so the portal's Messages tab
                //     renders it as part of the contact's thread.
                const { error: mErr } = await supabase.from("messages").insert({
                  client_id: clientId,
                  contact_id: contactId,
                  direction: "outbound",
                  body,
                  segments,
                  twilio_sid: twilioSid,
                  status: smsStatus,
                  to_number: lead.phone,
                  from_number: client.twilio_phone_number,
                  credits_charged: segments,
                });
                if (mErr) console.error("messages insert failed:", mErr);

                // 7b) Write the credit ledger debit for audit parity with
                //     manual sends / nudges / api/events welcome path.
                const { error: lErr } = await supabase.from("credit_ledger").insert({
                  client_id: clientId,
                  delta: -segments,
                  reason: "welcome_sms",
                  ref_id: twilioSid,
                });
                if (lErr) console.error("credit_ledger debit failed:", lErr);
              } else {
                // 8) Refund the credits since Twilio rejected the send
                await supabase.rpc("add_credits", {
                  p_client_id: clientId,
                  p_amount: segments,
                });
                await supabase.from("credit_ledger").insert({
                  client_id: clientId,
                  delta: segments,
                  reason: "refund",
                  ref_id: "welcome_send_failed",
                });
              }
            }
          }
        }

        // 9) Reflect delivery state back onto the lead row so the Leads tab
        //    shows the delivery badge immediately.
        await supabase.from("leads")
          .update({
            sms_delivered: smsDelivered,
            sms_status: smsDelivered ? (smsStatus || "sent") : "failed",
          })
          .eq("id", data.id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: data.id, sms_delivered: smsDelivered }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("capture-lead error:", err);
    return new Response(
      JSON.stringify({ error: "Invalid request" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
