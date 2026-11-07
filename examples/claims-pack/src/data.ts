/**
 * The demo tenant: 30 synthetic captures at a fictional carrier, Northfield Mutual. Every name,
 * policy and amount is made up; each row is tagged `demo` and `metadata.synthetic`.
 *
 * 18 drafts went out untouched and 12 were fixed, using every reason code at least once. Those are
 * illustration numbers for showing what the scorecard looks like, not results from any team.
 */
import { type CaptureCreate, CLAIMS_AGENTS, type CLAIMS_REASON_CODES } from "@overturn-ai/shared";

export const DEMO_TAG = "demo";

type ReasonCode = (typeof CLAIMS_REASON_CODES)[number]["code"];
type Decision = { coverage: "covered" | "partial" | "denied"; reserve: number; denial_reason: string | null };

const ADJUSTERS = [
  "adjuster.one@demo.overturn.run",
  "adjuster.two@demo.overturn.run",
  "adjuster.three@demo.overturn.run",
  "adjuster.four@demo.overturn.run",
];

interface Row {
  subject: string;
  customer: string;
  note: string;
  draft: string;
  /** Untouched when absent: how long the draft sat in front of the expert. */
  fix?: { sent: string; reasonCode: ReasonCode; reason: string };
  seconds?: number;
}

interface DecisionRow extends Omit<Row, "fix"> {
  decision: Decision;
  fix?: { sent: string; decision: Decision; reasonCode: ReasonCode; reason: string };
}

const replies: Row[] = [
  {
    subject: "Status of my windshield claim",
    customer: "I filed a claim for my cracked windshield on Monday. Has anything happened yet?",
    note: "Auto policy, glass coverage with $0 deductible. Vendor booked for Thursday.",
    draft:
      "Thanks for checking in. Your glass claim is approved with no deductible, and our vendor is booked to replace the windshield on Thursday. They will call you the morning of the appointment.",
    seconds: 8,
  },
  {
    subject: "Where do I send repair photos?",
    customer: "The body shop gave me photos of the damage. Where should I send them?",
    note: "Open collision claim, estimate pending.",
    draft:
      "You can reply to this message with the photos attached and they will go straight to your claim file. Once we have them we will finish the estimate review.",
    seconds: 6,
  },
  {
    subject: "Rental car while mine is in the shop",
    customer: "Am I covered for a rental while my car is being repaired?",
    note: "Rental reimbursement on policy: $40/day, 30 days maximum.",
    draft:
      "Yes. Your policy reimburses a rental at up to $40 per day for up to 30 days while your car is being repaired. Keep your receipt and send it to us when you return the rental.",
    seconds: 14,
  },
  {
    subject: "Change of address on my claim",
    customer: "We moved last week. Please send the check to our new address on Birch Lane.",
    note: "Address change verified against the policy record on the call.",
    draft:
      "We have updated your claim with the Birch Lane address, and any payment will be mailed there. You do not need to do anything else.",
    seconds: 5,
  },
  {
    subject: "When will I get my payment?",
    customer: "My adjuster said the claim was approved. How long until I get paid?",
    note: "Payment issued by EFT two days ago.",
    draft:
      "Your payment was issued by electronic transfer two days ago. Most banks post it within three business days, so it should reach your account by the end of this week.",
    seconds: 9,
  },
  {
    subject: "Copy of my claim file",
    customer: "My attorney asked for a copy of the claim documents. How do I request them?",
    note: "Document requests go through the records team.",
    draft:
      "We can send the claim documents to you or your attorney. Please reply with a signed authorization naming your attorney, and our records team will send the file within five business days.",
    seconds: 41,
  },
  {
    subject: "Adjuster has not called",
    customer: "I was told someone would call me about my fence. Nobody has.",
    note: "Inspection scheduled for tomorrow at 10am; confirmation email bounced.",
    draft:
      "I am sorry for the missed connection. Your inspection is scheduled for tomorrow at 10am, and our confirmation email did not reach you. The adjuster will call you before arriving.",
    seconds: 27,
  },
  {
    subject: "Do I need a police report?",
    customer: "Someone hit my parked car and drove off. Do I need a police report for the claim?",
    note: "Hit and run, collision coverage. Claims requires a police report on these.",
    draft:
      "Yes, please file a police report and send us the report number. We require a report for every hit and run claim.",
    seconds: 72,
  },
  {
    subject: "Claim number please",
    customer: "I lost the email with my claim number. Can you resend it?",
    note: "Claim NM-204417, opened last Tuesday.",
    draft:
      "Of course. Your claim number is NM-204417, opened last Tuesday. Please include it on anything you send us about this claim.",
    seconds: 4,
  },
  {
    subject: "Storm damage to the roof",
    customer: "Water came through the ceiling after Saturday's storm. What happens now?",
    note: "HO-3 policy, $1,000 deductible. Company rule: storm claims get contact within 2 business days.",
    draft:
      "We are sorry about the damage. We have opened your claim and an adjuster will contact you within 5 business days to arrange an inspection. Your $1,000 deductible applies.",
    fix: {
      sent: "We are sorry about the damage. We have opened your claim and an adjuster will contact you within 2 business days to arrange an inspection. Your $1,000 deductible applies. Please cover the opening with a tarp if it is safe to do so, and keep your receipts.",
      reasonCode: "missing_required_step",
      reason: "Storm claims get 2-day contact, and the mitigation request was missing",
    },
  },
  {
    subject: "Total loss settlement amount",
    customer: "You told me my car is a total loss. How much will I get?",
    note: "Actual cash value $18,400, deductible $500, sales tax owed in this state $1,104.",
    draft: "Your car's actual cash value is $18,400. After your $500 deductible, your settlement is $17,900.",
    fix: {
      sent: "Your car's actual cash value is $18,400, plus $1,104 in sales tax. After your $500 deductible, your settlement is $19,004.",
      reasonCode: "wrong_amount_or_date",
      reason: "Sales tax is owed on total losses in this state",
    },
  },
  {
    subject: "Deadline to appeal",
    customer: "I disagree with the decision on my claim. How long do I have to appeal?",
    note: "Denial letter dated March 3. Appeal window is 60 days from the letter date.",
    draft:
      "You can appeal within 30 days of your denial letter, which was dated March 3. Reply to this message to start.",
    fix: {
      sent: "You can appeal within 60 days of your denial letter, which was dated March 3, so by May 2. Reply to this message to start.",
      reasonCode: "wrong_amount_or_date",
      reason: "Appeal window is 60 days, not 30",
    },
  },
  {
    subject: "Frustrated about the delay",
    customer: "This has taken three weeks and I keep getting different answers.",
    note: "Awaiting contractor estimate; customer has called four times.",
    draft:
      "Per our records your claim remains pending receipt of the contractor estimate. Please be advised that delays may occur. Submit the estimate to proceed.",
    fix: {
      sent: "Three weeks is too long, and I am sorry you have had different answers. The one thing we still need is your contractor's estimate. Once it arrives I will review it myself and call you with the next step.",
      reasonCode: "tone_wording",
      reason: "Too cold for someone who has called four times",
    },
  },
];

const decisions: DecisionRow[] = [
  {
    subject: "Burst pipe in the kitchen",
    customer: "A pipe burst under the sink overnight and flooded the kitchen floor.",
    note: "HO-3, sudden and accidental water discharge. Plumber invoice and photos on file.",
    decision: { coverage: "covered", reserve: 8500, denial_reason: null },
    draft:
      "Sudden water damage from a burst pipe is covered under your policy. We have set up your claim and will review your plumber's invoice and the flooring estimate.",
    seconds: 11,
  },
  {
    subject: "Stolen bicycle from the garage",
    customer: "My bike was stolen out of my locked garage. It was worth about $900.",
    note: "HO-3 personal property, $500 deductible, police report on file, signs of forced entry.",
    decision: { coverage: "covered", reserve: 400, denial_reason: null },
    draft:
      "Theft from your locked garage is covered. After your $500 deductible, we expect to pay about $400 once we have your proof of ownership.",
    seconds: 7,
  },
  {
    subject: "Rear-ended at a stop light",
    customer: "Another driver hit me from behind at a light. The bumper is crushed.",
    note: "Collision coverage, $500 deductible, other driver admitted fault. Estimate $3,200.",
    decision: { coverage: "covered", reserve: 2700, denial_reason: null },
    draft:
      "Your collision coverage applies. We will pay for the repair less your $500 deductible and seek that amount back from the other driver's insurer.",
    seconds: 16,
  },
  {
    subject: "Hail damage to my car",
    customer: "Last week's hail left dents all over the hood and roof.",
    note: "Comprehensive coverage, $250 deductible. Estimate $2,750.",
    decision: { coverage: "covered", reserve: 2500, denial_reason: null },
    draft:
      "Hail damage is covered under your comprehensive coverage. Based on the $2,750 estimate and your $250 deductible, we expect to pay $2,500.",
    seconds: 19,
  },
  {
    subject: "Tree fell on the shed",
    customer: "A neighbor's tree came down in the wind and crushed our shed.",
    note: "HO-3 other structures coverage, $1,000 deductible. Contractor estimate $5,000.",
    decision: { coverage: "covered", reserve: 4000, denial_reason: null },
    draft:
      "Wind damage to your shed is covered under other structures. On the $5,000 estimate, after your $1,000 deductible, we expect to pay $4,000.",
    seconds: 34,
  },
  {
    subject: "Kitchen fire",
    customer: "A grease fire damaged our stove, cabinets and ceiling.",
    note: "HO-3, $1,000 deductible. Contents and dwelling; fire department report on file. Estimate $21,000.",
    decision: { coverage: "covered", reserve: 20000, denial_reason: null },
    draft:
      "Fire damage is covered for both your home and belongings. We will send an adjuster this week and can arrange a contractor if you need one.",
    seconds: 95,
  },
  {
    subject: "Damage to rental while traveling",
    customer: "Someone scraped my rental car in a parking lot on vacation.",
    note: "Collision extends to rental vehicles, $500 deductible. Rental company bill $1,300.",
    decision: { coverage: "covered", reserve: 800, denial_reason: null },
    draft:
      "Your collision coverage extends to rental cars. After your $500 deductible, we will pay the remaining $800 of the $1,300 bill.",
    seconds: 22,
  },
  {
    subject: "Laptop stolen from car",
    customer: "My work laptop was taken from my car at the gym.",
    note: "HO-3 personal property off-premises. Employer owns the laptop, per the customer's follow-up.",
    decision: { coverage: "denied", reserve: 0, denial_reason: "not_insured_property" },
    draft:
      "Because your employer owns the laptop, it is not your personal property under this policy, so we cannot cover it. Your employer's insurer is the right place to file.",
    seconds: 48,
  },
  {
    subject: "Basement water after heavy rain",
    customer: "Water seeped into the basement through the foundation walls during the rain.",
    note: "HO-3, no water backup or flood endorsement. Groundwater seepage confirmed by inspector.",
    decision: { coverage: "denied", reserve: 0, denial_reason: "flood_or_groundwater" },
    draft:
      "Water that enters through the foundation from the ground is excluded under your policy, and you do not have a flood endorsement, so we cannot cover this loss.",
    seconds: 63,
  },
  {
    subject: "Slow leak behind the shower",
    customer: "We found mold and rotten drywall behind the shower when we remodeled.",
    note: "HO-3. Inspector: leak ongoing for months, long-term seepage exclusion applies.",
    decision: { coverage: "covered", reserve: 12000, denial_reason: null },
    draft:
      "Water damage from your plumbing is covered. We have set up your claim and will review the contractor's estimate for the repair.",
    fix: {
      sent: "Our inspector found the leak had been running for months. Your policy excludes damage from continuous or repeated seepage, so we cannot cover this repair. You can appeal within 60 days of this letter.",
      decision: { coverage: "denied", reserve: 0, denial_reason: "long_term_seepage" },
      reasonCode: "missed_exclusion",
      reason: "Repeated seepage exclusion: leak ran for months",
    },
  },
  {
    subject: "Delivery driver accident",
    customer: "I was delivering food for an app when another car clipped my mirror and door.",
    note: "Personal auto policy, no rideshare or delivery endorsement. Active delivery at time of loss.",
    decision: { coverage: "covered", reserve: 1900, denial_reason: null },
    draft:
      "Your collision coverage applies to this accident. We will review the body shop's estimate and pay the repair less your deductible.",
    fix: {
      sent: "Your policy excludes accidents while delivering for pay, and it does not include a delivery endorsement, so we cannot cover this repair. The delivery app's commercial policy may apply, and I can send what you need to file with them.",
      decision: { coverage: "denied", reserve: 0, denial_reason: "commercial_use" },
      reasonCode: "missed_exclusion",
      reason: "Delivery use exclusion, no endorsement on the policy",
    },
  },
  {
    subject: "Sewer backup in basement",
    customer: "The sewer backed up into our basement and ruined the carpet.",
    note: "HO-3 with water backup endorsement, $10,000 limit, added in January.",
    decision: { coverage: "denied", reserve: 0, denial_reason: "flood_or_groundwater" },
    draft:
      "Damage from water entering the basement is excluded under your policy, so we cannot cover this loss.",
    fix: {
      sent: "Your policy includes a water backup endorsement with a $10,000 limit, so this loss is covered. We will review your carpet and cleanup invoices and pay them up to that limit, less your deductible.",
      decision: { coverage: "covered", reserve: 7500, denial_reason: null },
      reasonCode: "wrong_coverage_decision",
      reason: "Water backup endorsement on the policy since January",
    },
  },
  {
    subject: "Car damaged during a move",
    customer: "My car fell off the tow dolly while I was moving across the state.",
    note: "Collision coverage applies to upset of the vehicle, $500 deductible. Estimate $6,200.",
    decision: { coverage: "denied", reserve: 0, denial_reason: "not_a_covered_peril" },
    draft:
      "Damage during transport is not a covered event under your auto policy, so we cannot cover this repair.",
    fix: {
      sent: "Your collision coverage applies when your car overturns or is upset, including on a tow dolly. On the $6,200 estimate, after your $500 deductible, we expect to pay $5,700.",
      decision: { coverage: "covered", reserve: 5700, denial_reason: null },
      reasonCode: "wrong_coverage_decision",
      reason: "Upset of the vehicle is a collision loss",
    },
  },
  {
    subject: "Roof damage from windstorm",
    customer: "The wind ripped shingles off half the roof, and now there's a leak.",
    note: "HO-3, $1,000 deductible. Inspection: full slope replacement, estimate $15,000.",
    decision: { coverage: "covered", reserve: 4000, denial_reason: null },
    draft:
      "Wind damage to your roof is covered. We have set a repair allowance and will send your payment once the contractor's invoice arrives.",
    fix: {
      sent: "Wind damage to your roof is covered. Our inspection calls for replacing the full slope, so we are working from the $15,000 estimate, less your $1,000 deductible, and we will send your first payment this week.",
      decision: { coverage: "covered", reserve: 14000, denial_reason: null },
      reasonCode: "reserve_too_low",
      reason: "Roof replacement, not repair",
    },
  },
  {
    subject: "Injury at my rental property",
    customer: "A tenant slipped on the back steps and says they need surgery.",
    note: "Landlord liability, $300,000 limit. Attorney letter received; surgery estimate $60,000.",
    decision: { coverage: "covered", reserve: 15000, denial_reason: null },
    draft:
      "Your liability coverage applies. We will handle communication with your tenant from here. Please send us anything you receive about this.",
    fix: {
      sent: "Your liability coverage applies. Because your tenant has an attorney, please do not discuss the fall with your tenant directly and forward anything you receive to us right away. We will handle it from here.",
      decision: { coverage: "covered", reserve: 85000, denial_reason: null },
      reasonCode: "reserve_too_low",
      reason: "Attorney involved and surgery estimate: reserve for litigated BI",
    },
  },
  {
    subject: "Minor dent in parking lot",
    customer: "Someone dented my door in a parking lot. The estimate is $900.",
    note: "Collision coverage, $500 deductible. Estimate $900.",
    decision: { coverage: "covered", reserve: 5000, denial_reason: null },
    draft:
      "Your collision coverage applies. We will review the estimate and pay the repair less your deductible.",
    fix: {
      sent: "Your collision coverage applies. On the $900 estimate, after your $500 deductible, we will pay $400.",
      decision: { coverage: "covered", reserve: 400, denial_reason: null },
      reasonCode: "reserve_too_high",
      reason: "Default reserve on a $900 estimate",
    },
  },
  {
    subject: "Wildfire evacuation costs",
    customer: "We had to evacuate for six days. The fire never reached us, but the hotel cost $1,400.",
    note: "County evacuation order on file. Loss of use requires physical damage on this form. Claims manager approved a one-time exception.",
    decision: { coverage: "denied", reserve: 0, denial_reason: "no_physical_damage" },
    draft:
      "Because your home was not damaged, your policy's loss of use coverage does not apply, so we cannot reimburse the hotel.",
    fix: {
      sent: "Your home was not damaged, but the county ordered the evacuation, and our claims manager has approved covering your hotel. Please send the $1,400 receipt and we will reimburse it this week.",
      decision: { coverage: "partial", reserve: 1400, denial_reason: null },
      reasonCode: "policy_exception",
      reason: "County evacuation order; one-time exception approved by the claims manager",
    },
  },
];

function capture(i: number, agent: string, base: Omit<CaptureCreate, "externalId" | "actor" | "agent">) {
  return {
    ...base,
    agent,
    externalId: `zd:demo-${1001 + i}`,
    actor: ADJUSTERS[i % ADJUSTERS.length]!,
    draftModel: "gpt-4.1-mini",
    draftProvider: "openai",
    tags: [DEMO_TAG],
    metadata: { synthetic: true },
  } satisfies CaptureCreate;
}

function thread(r: Pick<Row, "customer" | "note">): CaptureCreate["context"] {
  return [
    { role: "customer", content: r.customer },
    { role: "note", content: r.note },
  ];
}

export const captures: CaptureCreate[] = [
  ...replies.map((r) => ({
    subject: r.subject,
    source: "zendesk" as const,
    context: thread(r),
    draft: { text: r.draft },
    sent: { text: r.fix?.sent ?? r.draft },
    reason: r.fix?.reason,
    reasonCode: r.fix?.reasonCode,
    secondsToSend: r.seconds,
  })),
  ...decisions.map((r) => ({
    subject: r.subject,
    source: "zendesk" as const,
    context: thread(r),
    draft: { text: r.draft, fields: r.decision },
    sent: { text: r.fix?.sent ?? r.draft, fields: r.fix?.decision ?? r.decision },
    reason: r.fix?.reason,
    reasonCode: r.fix?.reasonCode,
    secondsToSend: r.seconds,
  })),
].map((c, i) => capture(i, i < replies.length ? CLAIMS_AGENTS.reply : CLAIMS_AGENTS.decision, c));
