import type { NextApiRequest, NextApiResponse } from "next";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { handleCrispWebhook } from "@kan/api/utils/crisp";
import { createDrizzleClient } from "@kan/db/client";

const db = createDrizzleClient();

export default withRateLimit(
  // ponytail: generous limit — Crisp delivers every subscribed message event
  // for the whole website here, not just #card notes
  { points: 600, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ message: "Method not allowed" });
    }

    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) return res.status(404).json({ message: "Not found" });

    const result = await handleCrispWebhook(db, token, req.body);
    return res.status(result.status).json({ message: result.message });
  }),
);
