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

    // Send welcome SMS if the client has it enabled and has credits
    let smsDelivered = false;
    if (lead.phone) {
      const { data: client } = await supabase
        .from("clients")
        .select("credit_balance, welcome_sms_enabled, welcome_sms_template, twilio_phone_number, name")
        .eq("id", clientId)
        .single();

      if (client?.welcome_sms_enabled && (client.credit_balance ?? 0) > 0 && client.twilio_phone_number) {
        const firstName = lead.full_name ? lead.full_name.split(" ")[0] : "there";
        let smsBody = (client.welcome_sms_template || "Thanks for reaching out to {{client_name}}!")
          .replace("{{first_name}}", firstName)
          .replace("{{client_name}}", client.name || "us");

        const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
        const token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
        const auth = btoa(`${sid}:${token}`);
        const params = new URLSearchParams();
        params.set("To", lead.phone);
        params.set("From", client.twilio_phone_number);
        params.set("Body", smsBody);

        try {
          const twilioRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: params.toString(),
            },
          );
          smsDelivered = twilioRes.ok;

          if (smsDelivered) {
            await supabase.from("clients")
              .update({ credit_balance: (client.credit_balance ?? 0) - 1 })
              .eq("id", clientId);
          }

          await supabase.from("leads")
            .update({
              sms_delivered: smsDelivered,
              sms_status: smsDelivered ? "sent" : "failed",
            })
            .eq("id", data.id);
        } catch (err) {
          console.error("Twilio error:", err);
        }
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
