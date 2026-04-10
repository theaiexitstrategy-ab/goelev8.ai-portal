// Supabase Edge Function: islay-inbound-lead
// Receives POST from website chat widget, writes to leads table,
// checks SMS credit balance, sends welcome SMS via Twilio,
// and triggers auto-reload if threshold is hit.
//
// Deploy: supabase functions deploy islay-inbound-lead --no-verify-jwt
// URL:    https://bnkoqybkmwtrlorhowyv.supabase.co/functions/v1/islay-inbound-lead

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CLIENT_ID = "islay_studios";
const DEFAULT_BOOKING_URL = "https://www.islaystudiosllc.com";

const BUNDLES: Record<string, { price: number; credits: number; costPerCredit: number }> = {
  starter: { price: 2500,  credits: 250,  costPerCredit: 0.10 },
  growth:  { price: 5000,  credits: 625,  costPerCredit: 0.08 },
  pro:     { price: 10000, credits: 2000, costPerCredit: 0.05 },
};

async function sendSMS(to: string, body: string): Promise<boolean> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const from = Deno.env.get("TWILIO_PHONE_NUMBER")!;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = btoa(`${sid}:${token}`);

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", from);
  params.set("Body", body);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Twilio error:", err.message || err);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Twilio fetch error:", err);
    return false;
  }
}

async function triggerAutoReload(
  clientId: string,
  currentBalance: number,
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const { data: client } = await supabase
    .from("clients")
    .select("auto_reload_enabled, auto_reload_threshold, auto_reload_pack, stripe_customer_id")
    .eq("id", clientId)
    .single();

  if (!client?.auto_reload_enabled || !client.stripe_customer_id) return;
  if (currentBalance > (client.auto_reload_threshold ?? 50)) return;

  const bundle = BUNDLES[client.auto_reload_pack || "growth"];
  if (!bundle) return;

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    console.error("STRIPE_SECRET_KEY not set, cannot auto-reload");
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set("amount", String(bundle.price));
    params.set("currency", "usd");
    params.set("customer", client.stripe_customer_id);
    params.set("confirm", "true");
    params.set("off_session", "true");
    params.set("description", `Auto-reload for ${clientId}`);
    params.set("metadata[client_id]", clientId);
    params.set("metadata[pack]", client.auto_reload_pack || "growth");
    params.set("metadata[credits]", String(bundle.credits));
    params.set("metadata[auto_reload]", "true");

    const res = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const pi = await res.json();
    if (!res.ok || pi.status !== "succeeded") {
      console.error("Auto-reload charge failed:", pi.error?.message || pi.status);
      return;
    }

    // Add credits
    await supabase.rpc("increment_credit_balance", {
      p_client_id: clientId,
      p_amount: bundle.credits,
    }).then(async () => {
      // Fallback if RPC doesn't exist: manual update
    }).catch(async () => {
      const { data: row } = await supabase
        .from("clients").select("credit_balance").eq("id", clientId).single();
      await supabase.from("clients")
        .update({ credit_balance: (row?.credit_balance ?? 0) + bundle.credits })
        .eq("id", clientId);
    });

    console.log(`Auto-reload: added ${bundle.credits} credits for ${clientId}`);
  } catch (err) {
    console.error("Auto-reload error:", err);
  }
}

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

    let rawPhone: string | null =
      body.phone || body.phone_number || body.phoneNumber || null;
    if (rawPhone) {
      rawPhone = rawPhone.replace(/[\s\-().]/g, "");
      if (!rawPhone.startsWith("+")) {
        rawPhone = "+1" + rawPhone;
      }
    }

    const clientSlug = body.client_id || body.clientId || CLIENT_ID;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve slug to UUID
    const normalizedSlug = clientSlug.replace(/_/g, "-");
    const { data: clientRow } = await supabase
      .from("clients").select("id").eq("slug", normalizedSlug).single();
    if (!clientRow) {
      return new Response(JSON.stringify({ error: "Unknown client: " + clientSlug }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const clientId = clientRow.id;

    const fullName = body.full_name || body.fullName || body.name || null;
    const lead = {
      name: fullName || "Unknown",
      full_name: fullName,
      phone: rawPhone,
      email: body.email || null,
      source: body.lead_source || body.leadSource || body.source || "website",
      lead_source: body.lead_source || body.leadSource || body.source || null,
      artist_selected:
        body.artist_selected || body.artistSelected || body.matched_artist || body.artist || null,
      promo_code: body.promo_code || body.promoCode || "SLAY10",
      booking_platform: body.booking_platform || body.bookingPlatform || null,
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
      console.error("Supabase insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Check credit balance before sending SMS ---
    let smsDelivered = false;
    let smsStatus: string | null = null;

    if (lead.phone) {
      const { data: client } = await supabase
        .from("clients")
        .select("credit_balance")
        .eq("id", clientId)
        .single();

      const balance = client?.credit_balance ?? 0;

      if (balance <= 0) {
        smsStatus = "failed_no_credits";
        await supabase.from("leads")
          .update({ sms_delivered: false, sms_status: "failed_no_credits" })
          .eq("id", data.id);

        console.log(`SMS skipped for lead ${data.id}: no credits for ${clientId}`);
      } else {
        let bookingUrl = DEFAULT_BOOKING_URL;

        if (lead.artist_selected) {
          const { data: artist } = await supabase
            .from("artists")
            .select("booking_url")
            .eq("name", lead.artist_selected)
            .eq("client_id", clientId)
            .single();

          if (artist?.booking_url) {
            bookingUrl = artist.booking_url;
          }
        }

        const firstName = lead.full_name
          ? lead.full_name.split(" ")[0]
          : "there";

        const smsBody =
          `Hey ${firstName}, thanks for connecting with iSlay Studios! ` +
          `Here's your $10 off promo code: SLAY10. ` +
          `Book here: ${bookingUrl}`;

        smsDelivered = await sendSMS(lead.phone, smsBody);
        smsStatus = smsDelivered ? "sent" : "failed";

        if (smsDelivered) {
          const newBalance = balance - 1;
          await supabase.from("clients")
            .update({ credit_balance: newBalance })
            .eq("id", clientId);

          // Check auto-reload in background
          triggerAutoReload(clientId, newBalance, supabase).catch((err) =>
            console.error("Auto-reload check error:", err),
          );
        }

        await supabase.from("leads")
          .update({ sms_delivered: smsDelivered, sms_status: smsStatus })
          .eq("id", data.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        id: data.id,
        sms_delivered: smsDelivered,
        sms_status: smsStatus,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
