import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { sendNotification } from "./shared";

const CampaignWorkflowArgs = z.object({
  userId: z.string(),
  candidates: z.array(z.string()),
});

/**
 * Showcases:
 * - patches (callback + boolean)
 * - full deterministic RNG API
 * - state factory defaults (no dependencies)
 * - retention config
 */
export const campaignWorkflow = defineWorkflow({
  name: "campaign",
  args: CampaignWorkflowArgs,
  steps: { sendNotification },
  streams: { events: z.object({ type: z.string(), data: z.unknown() }) },
  patches: {
    multiChannel: true,
    legacySms: false,
  },
  rng: {
    session: true,
    cohort: (userId: string, wave: number) => `cohort:${userId}:${wave}`,
  },
  state: () => ({
    sessionId: "",
    cohortSeed: 0,
    launched: false,
    sentCount: 0,
  }),
  retention: {
    complete: 7 * 24 * 3600,
    failed: 30 * 24 * 3600,
    terminated: 24 * 3600,
  },

  async execute(ctx, args) {
    ctx.logger.info("Campaign starting", {
      sessionId: ctx.state.sessionId,
      cohortSeed: ctx.state.cohortSeed,
    });

    const sessionRng = ctx.rng.session;
    const campaignId = sessionRng.uuidv4();
    const initialCohortSeed = ctx.rng.cohort("setup", 0).int(1, 100);
    const batchSize = sessionRng.int(1, 10);
    const threshold = sessionRng.next();
    const runExperiment = sessionRng.bool();
    const sendImmediately = sessionRng.chance(0.8);
    const firstCandidate = sessionRng.pick(args.candidates);
    const selectedTier = sessionRng.weightedPick([
      { value: "premium", weight: 20 },
      { value: "standard", weight: 70 },
      { value: "basic", weight: 10 },
    ]);
    const shuffled = sessionRng.shuffle(args.candidates);
    const sampled = sessionRng.sample(
      args.candidates,
      Math.min(batchSize, args.candidates.length),
    );
    const token = sessionRng.string({
      length: 16,
      alphabet: "abcdef0123456789",
    });
    const nonce = sessionRng.bytes(8);
    const wave1Rng = ctx.rng.cohort(args.userId, 1);
    const wave1Id = wave1Rng.uuidv4();

    ctx.logger.info("Campaign params computed", {
      campaignId,
      initialCohortSeed,
      batchSize,
      threshold,
      runExperiment,
      sendImmediately,
      firstCandidate,
      selectedTier,
      shuffled,
      sampled,
      token,
      nonceLength: nonce.length,
      wave1Id,
    });

    await ctx.streams.events.write({
      type: "campaign_start",
      data: { campaignId },
    });

    const useLegacySms = await ctx.patches.legacySms();
    if (useLegacySms) {
      ctx.logger.info("Using legacy SMS path (replaying old workflow)");
    }

    const notificationId = await ctx.patches.multiChannel(async () => {
      const result = await ctx.steps.sendNotification(
        args.userId,
        `Campaign ${campaignId}: you are selected for ${selectedTier}`,
      );
      return result.notificationId;
    }, null);

    ctx.state.sessionId = campaignId;
    ctx.state.cohortSeed = initialCohortSeed;
    ctx.state.launched = true;
    for (const candidate of sampled) {
      await ctx.steps.sendNotification(
        candidate,
        `Campaign wave from ${args.userId}, token: ${token}`,
      );
      ctx.state.sentCount += 1;
    }

    await ctx.streams.events.write({
      type: "campaign_complete",
      data: { campaignId, notificationId, sent: ctx.state.sentCount },
    });
  },
});
