// ponytail: in-process scheduler for dev/self-host; Vercel uses vercel.json crons
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL) return;

  const g = globalThis as { __dueReminderTimer?: NodeJS.Timeout };
  if (g.__dueReminderTimer) return;

  const { createDrizzleClient } = await import("@kan/db/client");
  const { sendDueReminders } = await import("./pages/api/cron/due-reminders");
  const db = createDrizzleClient();

  g.__dueReminderTimer = setInterval(() => {
    sendDueReminders(db).catch((error) => {
      console.error("Due reminders failed:", error);
    });
  }, 60_000);
  console.log("[due-reminders] in-process scheduler started (60s interval)");
}
