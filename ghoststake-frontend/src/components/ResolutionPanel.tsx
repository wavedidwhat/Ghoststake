import { formatAmount, formatDuration, shortenAddress } from "@/lib/format";
import type { RoundQuestion } from "@/lib/positions";
import {
  challengeWindow,
  outcomeLabel,
  proposerInterest,
  questionHeadline,
} from "@/lib/resolution";

/**
 * How a question got its answer (GHO-91).
 *
 * A price round needs nothing like this: the feed published a number and
 * anybody can check the feed. A question has no such source — somebody had to
 * say what happened — so the panel's job is to show the *whole* claim, not
 * the answer it arrived at.
 *
 * Every row here exists because leaving it out would turn this back into an
 * operator saying "Brazil lost": who claimed it, against which document, what
 * that document's digest is, whether they had money on the answer, how long
 * anybody had to disagree, and who ruled if somebody did.
 */
export function ResolutionPanel({
  question,
  decimals,
  symbol,
  now,
}: {
  question: RoundQuestion;
  /** The market's stake asset decimals, for the proposer's own position. */
  decimals?: number;
  symbol?: string;
  /** Passed in so the countdown ticks where the caller ticks. */
  now?: Date;
}) {
  const window = challengeWindow(question, now);
  const interest = proposerInterest(question);
  const answer = outcomeLabel(question.outcome);

  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          How this gets answered
        </h3>
        {answer && question.state === "final" && (
          <span className="display rounded-control bg-brand-soft px-2 py-0.5 text-xs text-brand uppercase">
            {answer}
          </span>
        )}
      </div>

      <p className="display mt-2 text-base leading-snug text-ink">
        {questionHeadline(question)}
      </p>

      {/*
       * The window, stated as the thing it actually is. "Nobody argued" only
       * means something if the reader can see how long there was to argue and
       * that it has not run out yet.
       */}
      {window.open && (
        <p className="mt-2 text-sm text-ink-muted">
          {window.secondsLeft === null ? (
            <>Anyone can still argue with this.</>
          ) : (
            <>
              Anyone can argue with this for another{" "}
              <span className="tabular text-ink">
                {formatDuration(BigInt(window.secondsLeft))}
              </span>
              . It costs a bond, and being right pays the liar&rsquo;s.
            </>
          )}
        </p>
      )}

      <dl className="mt-4 space-y-2 text-sm">
        {question.proposer && (
          <Row label="Claimed by">
            <span className="tabular">{shortenAddress(question.proposer)}</span>
          </Row>
        )}

        {/*
         * The disclosure. Shown even when it is "nothing", because "we checked
         * and they held nothing" is the answer most people want and an absent
         * row would read as not having looked.
         */}
        {question.proposer && (
          <Row label="Their stake here">
            {interest === "unknown" ? (
              <span className="text-ink-faint">could not be read</span>
            ) : interest === "none" ? (
              <span className="text-ink-muted">nothing</span>
            ) : (
              <span className="tabular text-ink">
                {decimals === undefined || question.proposerStake === undefined
                  ? "…"
                  : `${formatAmount(BigInt(question.proposerStake), decimals, 2)}${symbol ? ` ${symbol}` : ""}`}
              </span>
            )}
          </Row>
        )}

        {question.evidenceUri && (
          <Row label="Evidence">
            {/*
             * `noreferrer` as well as `noopener`: an evidence URI is a link to
             * somewhere nobody here controls, and it should not learn which
             * round sent the reader.
             */}
            <a
              href={question.evidenceUri}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-ink underline-offset-4 hover:underline"
            >
              {question.evidenceUri}
            </a>
          </Row>
        )}

        {question.evidenceDigest && (
          <Row label="Digest">
            {/*
             * The only thing that makes the URI worth anything, since a
             * document at a URL can be rewritten after a claim is made.
             * Rendered in full and selectable so it can be compared against
             * `sha256sum` by hand.
             */}
            <span className="tabular break-all text-xs text-ink-muted select-all">
              {question.evidenceDigest}
            </span>
          </Row>
        )}

        {question.challenger && (
          <Row label="Argued by">
            <span className="tabular">{shortenAddress(question.challenger)}</span>
          </Row>
        )}

        {question.arbiter && (
          <Row label="Ruled by">
            <span className="tabular">{shortenAddress(question.arbiter)}</span>
          </Row>
        )}

        {question.reasonUri && (
          <Row label="Reasoning">
            <a
              href={question.reasonUri}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-ink underline-offset-4 hover:underline"
            >
              {question.reasonUri}
            </a>
          </Row>
        )}
      </dl>

      {question.state === "abandoned" && (
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          A question the process could not answer pays nobody. Both bonds went
          back and every stake in this round is refunded — nobody wins by
          staying quiet.
        </p>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}
