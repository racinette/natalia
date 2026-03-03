import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";

const VerificationMethod = z.enum([
  "passport",
  "driverLicense",
  "nationalId",
  "bankId",
  "videoSelfie",
]);

const ProofSubmission = z.object({
  artifactId: z.string(),
});

const VerifyIdentityProofResult = z.object({
  method: VerificationMethod,
  confidence: z.number(),
});

const UnlockAccountResult = z.object({
  sessionToken: z.string(),
});

const CancelResult = z.object({ ok: z.boolean() });

const RiskAssessmentArgs = z.object({
  userId: z.string(),
  methods: z.array(VerificationMethod),
});

const RiskAssessmentResult = z.object({
  risk: z.enum(["low", "medium", "high"]),
});

const verifyIdentityProof = defineStep({
  name: "verifyIdentityProof",
  execute: async (
    { signal },
    method: z.infer<typeof VerificationMethod>,
    artifactId: string,
    userId: string,
  ) => {
    const res = await fetch("https://api.identity.example.com/verify", {
      method: "POST",
      body: JSON.stringify({ method, artifactId, userId }),
      signal,
    });
    return res.json() as Promise<z.input<typeof VerifyIdentityProofResult>>;
  },
  schema: VerifyIdentityProofResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const unlockAccount = defineStep({
  name: "unlockAccount",
  execute: async (
    { signal },
    userId: string,
    methods: Array<z.infer<typeof VerificationMethod>>,
  ) => {
    const res = await fetch("https://api.identity.example.com/unlock", {
      method: "POST",
      body: JSON.stringify({ userId, methods }),
      signal,
    });
    return res.json() as Promise<z.input<typeof UnlockAccountResult>>;
  },
  schema: UnlockAccountResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const revokeSession = defineStep({
  name: "revokeSession",
  execute: async ({ signal }, sessionToken: string) => {
    await fetch("https://api.identity.example.com/session/revoke", {
      method: "POST",
      body: JSON.stringify({ sessionToken }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 10, intervalSeconds: 5 },
});

const riskAssessmentWorkflow = defineWorkflow({
  name: "riskAssessment",
  args: RiskAssessmentArgs,
  result: RiskAssessmentResult,
  async execute(_ctx, args) {
    if (args.methods.includes("videoSelfie") && args.methods.length >= 4) {
      return { risk: "low" as const };
    }
    if (args.methods.includes("videoSelfie")) {
      return { risk: "medium" as const };
    }
    return { risk: "high" as const };
  },
});

const OnboardingVerificationArgs = z.object({
  userId: z.string(),
});

/**
 * Showcases:
 * - onboarding with 5 identity methods and "at least 3" threshold
 * - `ctx.select().match()` with explicit handlers per identity method
 * - explicit deadline branch using `ctx.sleep()` (1 hour)
 * - gating progression until threshold is reached
 * - child workflow call after verification (`riskAssessment`)
 */
export const onboardingVerificationWorkflow = defineWorkflow({
  name: "onboardingVerification",
  args: OnboardingVerificationArgs,
  channels: {
    passport: ProofSubmission,
    driverLicense: ProofSubmission,
    nationalId: ProofSubmission,
    bankId: ProofSubmission,
    videoSelfie: ProofSubmission,
  },
  steps: {
    verifyIdentityProof,
    unlockAccount,
    revokeSession,
  },
  childWorkflows: {
    riskAssessment: riskAssessmentWorkflow,
  },
  result: z.object({
    status: z.enum(["verified", "rejected"]),
    verifiedMethods: z.array(VerificationMethod),
    failedMethods: z.array(VerificationMethod),
    risk: z.enum(["low", "medium", "high"]).nullable(),
    sessionToken: z.string().nullable(),
    reason: z.string().nullable(),
  }),

  async execute(ctx, args) {
    const verifiedMethods = new Set<z.infer<typeof VerificationMethod>>();
    const failedMethods = new Set<z.infer<typeof VerificationMethod>>();

    const outcome = await ctx.join(
      ctx.scope(
        "CollectVerificationProofs",
        {
          passport: ctx.steps.verifyIdentityProof(
            "passport",
            (await ctx.channels.passport.receive()).artifactId,
            args.userId,
          ),
          driverLicense: ctx.steps.verifyIdentityProof(
            "driverLicense",
            (await ctx.channels.driverLicense.receive()).artifactId,
            args.userId,
          ),
          nationalId: ctx.steps.verifyIdentityProof(
            "nationalId",
            (await ctx.channels.nationalId.receive()).artifactId,
            args.userId,
          ),
          bankId: ctx.steps.verifyIdentityProof(
            "bankId",
            (await ctx.channels.bankId.receive()).artifactId,
            args.userId,
          ),
          videoSelfie: ctx.steps.verifyIdentityProof(
            "videoSelfie",
            (await ctx.channels.videoSelfie.receive()).artifactId,
            args.userId,
          ),
          deadline: async () => {
            await ctx.sleep(3600);
            return "deadline" as const;
          },
        },
        async (
          ctx,
          {
            passport,
            driverLicense,
            nationalId,
            bankId,
            videoSelfie,
            deadline,
          },
        ) => {
          const sel = ctx.select({
            passport,
            driverLicense,
            nationalId,
            bankId,
            videoSelfie,
            deadline,
          });

          for await (const kind of sel.match({
            deadline: () => "deadline" as const,
            videoSelfie: {
              complete: (data) => {
                if (data.confidence < 0.8) {
                  failedMethods.add("videoSelfie");
                } else {
                  verifiedMethods.add("videoSelfie");
                }
                return "continue" as const;
              },
              failure: async () => {
                failedMethods.add("videoSelfie");
                return "continue" as const;
              },
            },
            passport: {
              complete: () => {
                verifiedMethods.add("passport");
                return "continue" as const;
              },
              failure: async () => {
                failedMethods.add("passport");
                return "continue" as const;
              },
            },
            driverLicense: {
              complete: () => {
                verifiedMethods.add("driverLicense");
                return "continue" as const;
              },
              failure: async () => {
                failedMethods.add("driverLicense");
                return "continue" as const;
              },
            },
            nationalId: {
              complete: () => {
                verifiedMethods.add("nationalId");
                return "continue" as const;
              },
              failure: async () => {
                failedMethods.add("nationalId");
                return "continue" as const;
              },
            },
            bankId: {
              complete: () => {
                verifiedMethods.add("bankId");
                return "continue" as const;
              },
              failure: async () => {
                failedMethods.add("bankId");
                return "continue" as const;
              },
            },
          })) {
            if (kind === "deadline") break;
            if (verifiedMethods.size >= 3) break;
            const remainingPossible = sel.remaining.size;
            if (verifiedMethods.size + remainingPossible < 3) break;
          }

          if (verifiedMethods.size < 3) {
            return {
              status: "rejected" as const,
              risk: null,
              sessionToken: null,
              reason: "Insufficient verified identification within 1 hour.",
            };
          }

          const methods = Array.from(verifiedMethods);
          const sessionToken = await ctx.join(
            ctx.steps
              .unlockAccount(args.userId, methods)
              .compensate(async (ctx, result) => {
                if (result.status === "complete") {
                  await ctx.join(
                    ctx.steps.revokeSession(result.data.sessionToken),
                  );
                }
              })
              .complete((data) => data.sessionToken),
          );

          const risk = await ctx.join(
            ctx.childWorkflows
              .riskAssessment({
                idempotencyKey: `risk-${args.userId}`,
                args: { userId: args.userId, methods },
              })
              .failure(async (failure) => {
                if (failure.status === "failed") {
                  ctx.logger.warn("Risk assessment failed", {
                    error: failure.error.message,
                  });
                } else {
                  ctx.logger.warn("Risk assessment terminated", {
                    reason: failure.reason,
                  });
                }
                return "high" as const;
              })
              .complete((data) => data.risk),
          );

          return {
            status: "verified" as const,
            risk,
            sessionToken,
            reason: null,
          };
        },
      ),
    );

    return {
      status: outcome.status,
      verifiedMethods: Array.from(verifiedMethods),
      failedMethods: Array.from(failedMethods),
      risk: outcome.risk,
      sessionToken: outcome.sessionToken,
      reason: outcome.reason,
    };
  },
});
