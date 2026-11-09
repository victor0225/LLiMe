import { useId } from 'react';
import { INVITATION_COPY } from '@core/copy';
import type { Activity } from '@core/domain';
import { Mascot } from './Mascot';

export type InvitationProps = {
  // The committed invitation. Its title and body are the server's choice for the cited evidence.
  readonly invitation: Activity;
  // An accept request is in flight.
  readonly isBusy: boolean;
  // Learning commands are not allowed right now, for example while the connection is paused.
  readonly isDisabled: boolean;
  readonly onAccept: () => void;
  readonly onLater: () => void;
};

// Opening the invitation is not consent: nothing starts until the child chooses Let's try.
export function Invitation({ invitation, isBusy, isDisabled, onAccept, onLater }: InvitationProps) {
  const headingId = useId();
  return (
    <section className="student-card student-invitation" aria-labelledby={headingId}>
      <Mascot state="welcome" />
      <div className="student-invitation-copy">
        <h1 id={headingId}>{invitation.title}</h1>
        <p className="student-tutor">{invitation.body}</p>
        <div className="student-actions">
          <button type="button" className="p-button student-primary" disabled={isDisabled || isBusy} aria-busy={isBusy} onClick={onAccept}>
            {invitation.primaryLabel}
          </button>
          <button type="button" className="p-button student-primary" data-variant="secondary" disabled={isBusy} onClick={onLater}>
            {invitation.secondaryLabel ?? INVITATION_COPY.later}
          </button>
        </div>
      </div>
    </section>
  );
}

// After Later: a quiet way back to the same invitation, with no reminder until the child returns.
export function DeferredInvitation({ onReturn }: { readonly onReturn: () => void }) {
  return (
    <section className="student-card student-deferred">
      <Mascot state="idle" size={120} />
      <h1 className="student-tutor">{INVITATION_COPY.deferred}</h1>
      <button type="button" className="p-button" data-variant="secondary" onClick={onReturn}>
        {INVITATION_COPY.returnToActivity}
      </button>
    </section>
  );
}
