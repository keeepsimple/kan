import { z } from "zod";

export const analyticsFilterSchema = z.object({
  workspacePublicId: z.string().min(12),
  from: z.coerce.date(),
  to: z.coerce.date(),
  boardPublicId: z.string().min(12).optional(),
  memberPublicId: z.string().min(12).optional(),
});

export const overviewResponseSchema = z.object({
  totalActivity: z.number(),
  completedCards: z.number(),
  onTimeRate: z.number(),
  avgCycleTimeSeconds: z.number(),
  previous: z.object({
    totalActivity: z.number(),
    completedCards: z.number(),
    onTimeRate: z.number(),
    avgCycleTimeSeconds: z.number(),
  }),
});

export const memberBreakdownResponseSchema = z.object({
  members: z.array(
    z.object({
      memberPublicId: z.string(),
      email: z.string(),
      activity: z.number(),
      completed: z.number(),
      onTime: z.number(),
      late: z.number(),
      overdue: z.number(),
      avgCycleTimeSeconds: z.number(),
    }),
  ),
});

export const timeSeriesResponseSchema = z.object({
  points: z.array(z.object({ day: z.string(), count: z.number() })),
});

export const analyticsMembersResponseSchema = z.object({
  members: z.array(z.object({ publicId: z.string(), email: z.string() })),
});
