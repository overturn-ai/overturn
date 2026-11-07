"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { track } from "@/components/analytics/PostHogProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { pct } from "@/lib/utils";

/**
 * The capture scorecard: the number a claims leader reads. How much of the AI's work went
 * out untouched, who is fixing the rest, and why.
 */
export default function CapturePage() {
  const [days, setDays] = useState(30);
  const [agent, setAgent] = useState("");
  const stats = useQuery({
    queryKey: ["capture-stats", days, agent],
    queryFn: () => client.corrections.captureStats({ days, agent: agent || undefined }),
  });
  const s = stats.data;
  const maxWeek = Math.max(1, ...(s?.weekly.map((w) => w.captures) ?? [1]));
  const [copied, setCopied] = useState(false);

  // The forwardable version: the three numbers and the reasons, as plain text the buyer can read
  // in an email on a phone. This is the handoff from the installer to the person who pays.
  const summary = s
    ? [
        `AI drafts, last ${days} days${agent ? ` (${agent})` : ""}`,
        ``,
        `Sent untouched: ${pct(s.untouchedRate)} (${s.untouched} of ${s.captures})`,
        `Fixes kept: ${s.edited}`,
        `Experts capturing: ${s.experts}`,
        ``,
        ...(s.byReason.length
          ? ["Why drafts were changed:", ...s.byReason.map((r) => `  ${r.label}: ${r.count}`)]
          : []),
        ``,
        `Every fix runs as a test before the next model or prompt change.`,
        `${typeof window !== "undefined" ? window.location.origin : "https://app.overturn.run"}/capture`,
      ].join("\n")
    : "";
  const forward = (how: "mail" | "copy") => {
    track.scorecardForwarded();
    if (how === "mail") {
      const subject = `AI draft scorecard, last ${days} days: ${pct(s?.untouchedRate ?? 0)} sent untouched`;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summary)}`;
    } else {
      void navigator.clipboard?.writeText(summary).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Capture</h1>
          <p className="text-sm text-muted-foreground">
            Every reply your experts sent from the tool they work in, scored: untouched means the draft went
            out as written.
          </p>
        </div>
        <div className="flex items-end gap-2">
          {s && s.captures > 0 ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => forward("copy")}
                data-testid="copy-scorecard"
              >
                {copied ? "Copied" : "Copy summary"}
              </Button>
              <Button size="sm" onClick={() => forward("mail")} data-testid="forward-scorecard">
                Send this week
              </Button>
            </>
          ) : null}
          <Input
            placeholder="agent"
            className="w-40"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          />
          <NativeSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            <option value="7">last 7 days</option>
            <option value="30">last 30 days</option>
            <option value="90">last 90 days</option>
            <option value="365">last year</option>
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Sent untouched</CardDescription>
            <CardTitle
              className="font-mono text-3xl font-normal tabular-nums"
              data-testid="capture-untouched"
            >
              {s ? pct(s.untouchedRate) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? `${s.untouched} of ${s.captures} drafts went out as written` : ""}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Expert fixes kept</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {s ? s.edited : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? (
              <Link className="underline" href="/cases">
                tone fixes aside, each one is a case and a training row
              </Link>
            ) : (
              ""
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Experts capturing</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {s ? s.experts : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? s.bySource.map((x) => `${x.source} ${x.count}`).join(" · ") : ""}
          </CardContent>
        </Card>
      </div>

      {s && s.captures === 0 ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Nothing captured in this window. Install the Zendesk app or call <code>POST /v1/capture</code>{" "}
            from the tool your experts work in; the first reply they send shows up here.
          </CardContent>
        </Card>
      ) : null}

      {s && s.weekly.length > 0 ? (
        <Card>
          <CardHeader>
            <CardDescription>By week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1.5" style={{ height: 96 }}>
              {s.weekly.map((w) => (
                <div
                  key={w.weekStart}
                  className="flex flex-1 flex-col justify-end gap-0.5"
                  title={`${w.weekStart.slice(0, 10)}: ${w.captures} captured, ${w.edited} edited`}
                >
                  <div
                    className="w-full rounded-t-sm bg-foreground/80"
                    style={{ height: `${(w.edited / maxWeek) * 88}px` }}
                  />
                  <div
                    className="w-full bg-foreground/25"
                    style={{ height: `${((w.captures - w.edited) / maxWeek) * 88}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">dark: edited · light: sent untouched</div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {s && s.byExpert.length > 0 ? (
          <Card>
            <CardHeader>
              <CardDescription>Fixes kept, by expert</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Expert</TH>
                    <TH className="text-right">Fixes kept</TH>
                  </TR>
                </THead>
                <TBody>
                  {s.byExpert.map((a) => (
                    <TR key={a.actor ?? "-"}>
                      <TD>{a.actor ?? <span className="text-muted-foreground">unknown</span>}</TD>
                      <TD className="text-right tabular-nums">{a.fixesKept}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="px-4 py-2 text-xs text-muted-foreground">
                Credit for expertise captured. There is no per-person rate anywhere in Overturn.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardDescription>Time from draft to send (untouched sends)</CardDescription>
            </CardHeader>
            <CardContent>
              {s && s.timeToSend.timed > 0 ? (
                <div className="space-y-1.5">
                  {s.timeToSend.buckets.map((b) => (
                    <div key={b.label} className="flex items-center gap-2 text-sm">
                      <span className="w-14 text-muted-foreground">{b.label}</span>
                      <div className="h-2 flex-1 rounded-sm bg-accent">
                        <div
                          className="h-2 rounded-sm bg-foreground/70"
                          style={{ width: `${(b.count / s.timeToSend.timed) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right tabular-nums">
                        {Math.round((b.count / s.timeToSend.timed) * 100)}%
                      </span>
                    </div>
                  ))}
                  <p className="pt-1 text-xs text-muted-foreground">
                    Team-level only. Fast untouched sends are where a sampled second review earns its keep.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No timed sends yet; the Zendesk app records this automatically.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardDescription>Why experts changed the draft</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Reason</TH>
                  <TH className="text-right">Times</TH>
                </TR>
              </THead>
              <TBody>
                {(s?.byReason ?? []).map((r) => (
                  <TR key={r.reason}>
                    <TD>
                      {r.label}
                      {r.excluded ? (
                        <span className="ml-2 text-xs text-muted-foreground">kept, not in the suite</span>
                      ) : null}
                    </TD>
                    <TD className="text-right tabular-nums">{r.count}</TD>
                  </TR>
                ))}
                {s && s.byReason.length === 0 ? (
                  <TR>
                    <TD colSpan={2} className="text-muted-foreground">
                      No reasons yet. Turn on "require a reason" in the Zendesk app to collect them.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {s && s.byAgent.length > 1 ? (
        <Card>
          <CardHeader>
            <CardDescription>By workflow</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH className="text-right">Captured</TH>
                  <TH className="text-right">Edited</TH>
                </TR>
              </THead>
              <TBody>
                {s.byAgent.map((a) => (
                  <TR key={a.agent}>
                    <TD>
                      <Link className="underline" href={`/cases?agent=${encodeURIComponent(a.agent)}`}>
                        {a.agent}
                      </Link>
                    </TD>
                    <TD className="text-right tabular-nums">{a.captures}</TD>
                    <TD className="text-right tabular-nums">{a.edited}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
