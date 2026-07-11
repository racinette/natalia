// Regression test — channel receive accepts relative seconds or absolute Date deadline.

import { z } from "zod";
import { defineWorkflow } from "../workflow";
import type { ChannelReceiveCall, ChannelReceiveDeadline } from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { explicitKeyIdentity } from "./test-identity";

const channelDeadlineWorkflow = defineWorkflow({
  name: "channelDeadlineRegression",
  args: z.undefined(),
  metadata: z.undefined(),
  identity: explicitKeyIdentity,
  channels: { inbox: z.object({ text: z.string() }) },
  result: z.void(),
  async execute(ctx) {
    const bySeconds = ctx.channels.inbox.receive(30);
    const byDate = ctx.channels.inbox.receive(new Date("2027-01-01T00:00:00.000Z"));
    const withDefault = ctx.channels.inbox.receive(
      new Date("2027-01-01T00:00:00.000Z"),
      { text: "timeout" },
    );

    type _SecondsCall = Assert<
      IsEqual<typeof bySeconds, ChannelReceiveCall<{ text: string } | undefined>>
    >;
    type _DateCall = Assert<
      IsEqual<typeof byDate, ChannelReceiveCall<{ text: string } | undefined>>
    >;
    type _DateDefaultHasDeadline = Assert<
      ChannelReceiveDeadline extends number | Date ? true : false
    >;

    void (0 as unknown as _SecondsCall);
    void (0 as unknown as _DateCall);
    void (0 as unknown as _DateDefaultHasDeadline);

    await bySeconds;
    await byDate;
    await withDefault;
  },
});

type _DeadlineUnion = Assert<
  IsEqual<ChannelReceiveDeadline, number | Date>
>;

void channelDeadlineWorkflow;
