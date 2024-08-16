import { NextResponse, type NextRequest } from "next/server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { z } from "zod";

import { FluxHashids } from "@/db/dto/flux.dto";
import { prisma } from "@/db/prisma";
import { getUserCredit } from "@/db/queries/account";
import { BillingType } from "@/db/type";
import { env } from "@/env.mjs";
import { getErrorMessage } from "@/lib/handle-error";
import { redis } from "@/lib/redis";

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
  analytics: true,
});

function getKey(id: string) {
  return `generate:${id}`;
}
enum model {
  pro = "black-forest-labs/flux-pro",
  schnell = "black-forest-labs/flux-schnell",
}

enum Ratio {
  r1 = "1:1",
  r2 = "16:9",
  r3 = "9:16",
  r4 = "3:2",
  r5 = "2:3",
}

type Params = { params: { key: string } };
const CreateGenerateSchema = z.object({
  model: z.enum([model.pro, model.schnell]),
  inputPrompt: z.string(),
  aspectRatio: z.enum([Ratio.r1, Ratio.r2, Ratio.r3, Ratio.r4, Ratio.r5]),
  isPrivate: z.number().default(0),
  locale: z.string().default("en"),
});

const Credits = {
  [model.pro]: 80,
  [model.schnell]: 15,
};
export async function POST(req: NextRequest, { params }: Params) {
  const { userId } = auth();

  const user = await currentUser();
  if (!userId || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { success } = await ratelimit.limit(
    getKey(user.id) + `_${req.ip ?? ""}`,
  );
  if (!success) {
    return new Response("Too Many Requests", {
      status: 429,
    });
  }

  try {
    const data = await req.json();
    const { model, inputPrompt, aspectRatio, isPrivate, locale } =
      CreateGenerateSchema.parse(data);
    const headers = new Headers();
    const account = await getUserCredit(userId);
    const needCredit = Credits[model];
    if (!account.credit || account.credit < needCredit) {
      return NextResponse.json(
        { error: "Insufficient credit" },
        { status: 400 },
      );
    }
    headers.append("Content-Type", "application/json");
    headers.append("API-TOKEN", "flux_400bd52fd5a1849c747e7189266428fa");

    const res = await fetch("https://api.noobdriver.com/flux/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input_prompt: inputPrompt,
        aspect_ratio: aspectRatio,
        is_private: isPrivate,
        user_id: userId,
        locale,
      }),
    }).then((res) => res.json());
    console.log("res--->", res);
    const fluxData = await prisma.fluxData.findFirst({
      where: {
        replicateId: res.replicate_id,
      },
    });
    if (!fluxData) {
      return NextResponse.json({ error: "Create Task Error" }, { status: 400 });
    }

    console.log("fluxData--->", fluxData);

    await prisma.$transaction(async (tx) => {
      const newAccount = await tx.userCredit.update({
        where: { id: account.id },
        data: {
          credit: {
            decrement: needCredit,
          },
        },
      });
      const billing = await tx.userBilling.create({
        data: {
          userId,
          fluxId: fluxData.id,
          state: "Done",
          amount: -needCredit,
          type: BillingType.Withdraw,
          description: `Generate ${model} - ${aspectRatio} Withdraw`,
        },
      });

      await tx.userCreditTransaction.create({
        data: {
          userId,
          credit: -needCredit,
          balance: newAccount.credit,
          billingId: billing.id,
          type: "Generate",
        },
      });
    });
    return NextResponse.json({ id: FluxHashids.encode(fluxData.id) });
  } catch (error) {
    console.log("error-->", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 400 },
    );
  }
}
