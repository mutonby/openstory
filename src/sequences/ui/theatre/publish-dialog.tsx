/**
 * Publish to social (#1267). Three steps: pick the profile, platforms and
 * caption; review exactly what will be sent; then follow each platform's
 * outcome. What the review shows is what the server receives — changing
 * anything means going back and reviewing again, and the server derives the
 * request id from those same values, so a repeat is found, not re-posted.
 */

import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Textarea } from '@/ui/shadcn/textarea';
import {
  getSocialPublishStatusFn,
  listSocialProfilesFn,
  publishSequenceExportFn,
} from '@/sequences/social-publish.fn';
import {
  publishInputSchema,
  socialPlatformLabel,
  SOCIAL_PLATFORMS,
  TIKTOK_PRIVACY,
  YOUTUBE_PRIVACY,
  YOUTUBE_TITLE_MAX,
  type PublishInput,
  type PublishOutcome,
  type SocialPlatform,
  type SocialProfile,
} from '@/sequences/social-publish';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useId, useState } from 'react';

type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  sequenceId: string;
  /** The ready render of the current cut. Captured when the dialog opens. */
  exportId: string;
  defaultTitle: string;
};

type Step =
  | { kind: 'form' }
  | { kind: 'review'; input: PublishInput }
  | { kind: 'tracking'; outcome: PublishOutcome; startedAt: number };

export function PublishDialog(props: PublishDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' });

  const onOpenChange = (open: boolean) => {
    if (!open) setStep({ kind: 'form' });
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish to social</DialogTitle>
          <DialogDescription>
            Post this render to your connected accounts through Upload-Post.
          </DialogDescription>
        </DialogHeader>
        {step.kind === 'form' && (
          <Suspense fallback={<FormSkeleton />}>
            <PublishForm
              {...props}
              onReview={(input) => setStep({ kind: 'review', input })}
              onCancel={() => onOpenChange(false)}
            />
          </Suspense>
        )}
        {step.kind === 'review' && (
          <PublishReview
            input={step.input}
            onBack={() => setStep({ kind: 'form' })}
            onPublished={(outcome) =>
              setStep({ kind: 'tracking', outcome, startedAt: Date.now() })
            }
          />
        )}
        {step.kind === 'tracking' && (
          <PublishTracking
            teamId={props.teamId}
            outcome={step.outcome}
            startedAt={step.startedAt}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function PublishForm({
  teamId,
  sequenceId,
  exportId,
  defaultTitle,
  onReview,
  onCancel,
}: PublishDialogProps & {
  onReview: (input: PublishInput) => void;
  onCancel: () => void;
}) {
  const ids = {
    title: useId(),
    description: useId(),
    privacy: useId(),
    tiktokPrivacy: useId(),
  };
  const { data: profiles } = useSuspenseQuery({
    queryKey: ['social-profiles', teamId],
    queryFn: () => listSocialProfilesFn({ data: { teamId } }),
    staleTime: 60_000,
  });
  const [profileName, setProfileName] = useState(
    profiles.length === 1 ? (profiles[0]?.username ?? '') : ''
  );
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const profile: SocialProfile | undefined = profiles.find(
    (p) => p.username === profileName
  );

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Your Upload-Post account has no profiles yet. Create one and connect
          your social accounts at app.upload-post.com, then come back.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = publishInputSchema.safeParse({
      sequenceId,
      exportId,
      profile: profileName,
      platforms,
      title: form.get('title'),
      description: form.get('description') || undefined,
      youtubePrivacy: form.get('youtubePrivacy') ?? 'private',
      tiktokPrivacy: form.get('tiktokPrivacy') ?? 'account_default',
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    setError(null);
    onReview(parsed.data);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Upload-Post profile</Label>
        <Select
          value={profileName}
          onValueChange={(value) => {
            setProfileName(value ?? '');
            setPlatforms([]);
          }}
        >
          <SelectTrigger aria-label="Upload-Post profile">
            <SelectValue placeholder="Choose a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem key={p.username} value={p.username}>
                {p.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {profile && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Platforms</legend>
          {profile.platforms.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No accounts connected on this profile.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {SOCIAL_PLATFORMS.filter((p) =>
                profile.platforms.includes(p.id)
              ).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={platforms.includes(p.id)}
                    onCheckedChange={(checked) =>
                      setPlatforms((current) =>
                        checked === true
                          ? [...current, p.id]
                          : current.filter((id) => id !== p.id)
                      )
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.title}>Caption</Label>
        <Input
          id={ids.title}
          name="title"
          defaultValue={defaultTitle}
          required
          autoComplete="off"
        />
        {platforms.includes('youtube') && (
          <p className="text-xs text-muted-foreground">
            Also the YouTube title — {YOUTUBE_TITLE_MAX} characters max.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.description}>Description (optional)</Label>
        <Textarea id={ids.description} name="description" rows={3} />
        <p className="text-xs text-muted-foreground">
          Used on YouTube, LinkedIn and Facebook.
        </p>
      </div>

      {platforms.includes('youtube') && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={ids.privacy}>YouTube visibility</Label>
          <Select name="youtubePrivacy" defaultValue="private">
            <SelectTrigger id={ids.privacy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YOUTUBE_PRIVACY.map((value) => (
                <SelectItem key={value} value={value}>
                  {value[0]?.toUpperCase()}
                  {value.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {platforms.includes('tiktok') && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={ids.tiktokPrivacy}>TikTok visibility</Label>
          <Select name="tiktokPrivacy" defaultValue="account_default">
            <SelectTrigger id={ids.tiktokPrivacy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIKTOK_PRIVACY.map((value) => (
                <SelectItem key={value} value={value}>
                  {TIKTOK_PRIVACY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={platforms.length === 0}>
          Review
        </Button>
      </DialogFooter>
    </form>
  );
}

function PublishReview({
  input,
  onBack,
  onPublished,
}: {
  input: PublishInput;
  onBack: () => void;
  onPublished: (outcome: PublishOutcome) => void;
}) {
  const posthog = usePostHog();
  const publish = useMutation({
    mutationFn: () => publishSequenceExportFn({ data: input }),
    onSuccess: (outcome) => {
      posthog.capture('social_publish_submitted', {
        sequence_id: input.sequenceId,
        platforms: input.platforms,
        state: outcome.state,
      });
      onPublished(outcome);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Profile</dt>
        <dd>{input.profile}</dd>
        <dt className="text-muted-foreground">Platforms</dt>
        <dd>{input.platforms.map(socialPlatformLabel).join(', ')}</dd>
        <dt className="text-muted-foreground">Caption</dt>
        <dd className="break-words">{input.title}</dd>
        {input.description && (
          <>
            <dt className="text-muted-foreground">Description</dt>
            <dd className="break-words whitespace-pre-wrap">
              {input.description}
            </dd>
          </>
        )}
        {input.platforms.includes('youtube') && (
          <>
            <dt className="text-muted-foreground">YouTube</dt>
            <dd>{input.youtubePrivacy ?? 'private'}</dd>
          </>
        )}
        {input.platforms.includes('tiktok') && (
          <>
            <dt className="text-muted-foreground">TikTok</dt>
            <dd>
              {TIKTOK_PRIVACY_LABELS[input.tiktokPrivacy ?? 'account_default']}
            </dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">
        Posts are labelled as AI-generated where the platform supports it.
        Published posts can't be undone from here.
      </p>
      {publish.error && (
        <p role="alert" className="text-sm text-destructive">
          {publish.error.message}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={publish.isPending}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={() => publish.mutate()}
          disabled={publish.isPending}
        >
          {publish.isPending ? 'Publishing…' : 'Publish'}
        </Button>
      </DialogFooter>
    </div>
  );
}

const TIKTOK_PRIVACY_LABELS: Record<(typeof TIKTOK_PRIVACY)[number], string> = {
  account_default: "Account's default",
  SELF_ONLY: 'Only me',
};

// Upload-Post caches "not found" for a short while, and an unconfirmed call
// may still be registering, so give the request id this long to appear
// before saying it could not be confirmed.
const REGISTER_GRACE_MS = 2 * 60 * 1000;
const POLL_MS = 5_000;

function PublishTracking({
  teamId,
  outcome,
  startedAt,
  onClose,
}: {
  teamId: string;
  outcome: PublishOutcome;
  startedAt: number;
  onClose: () => void;
}) {
  const {
    data: status,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['social-publish-status', outcome.requestId],
    queryFn: () =>
      getSocialPublishStatusFn({
        data: { teamId, requestId: outcome.requestId },
      }),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === 'done') return false;
      if (state === 'not_found' && Date.now() - startedAt > REGISTER_GRACE_MS) {
        return false;
      }
      return POLL_MS;
    },
  });

  // Flips once the grace window has passed; rendering never reads the clock.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const remaining = startedAt + REGISTER_GRACE_MS - Date.now();
    const id = window.setTimeout(
      () => setGraceOver(true),
      Math.max(0, remaining)
    );
    return () => window.clearTimeout(id);
  }, [startedAt]);
  const notConfirmed = status?.state === 'not_found' && graceOver;

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="text-sm">
        {outcome.state === 'resumed'
          ? 'This exact post was already sent — showing its progress. Nothing was sent again.'
          : status?.state === 'done'
            ? 'Finished.'
            : notConfirmed
              ? 'Upload-Post has no record of this post yet. It may still appear — check again in a few minutes before publishing again.'
              : outcome.state === 'unconfirmed'
                ? 'Upload-Post did not confirm the request. Checking whether it arrived…'
                : 'Publishing…'}
      </p>
      {status && status.results.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {status.results.map((result) => (
            <li key={result.platform} className="flex flex-col gap-0.5">
              <span className="font-medium">
                {socialPlatformLabel(result.platform)} —{' '}
                {result.state === 'published'
                  ? 'published'
                  : result.state === 'skipped'
                    ? 'skipped'
                    : result.state === 'failed'
                      ? 'failed'
                      : 'in progress'}
              </span>
              {result.url && (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-muted-foreground underline underline-offset-2"
                >
                  {result.url}
                </a>
              )}
              {(result.error ?? result.note) && (
                <span className="text-muted-foreground">
                  {result.error ?? result.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {status?.message && status.state === 'done' && (
        <p className="text-sm text-muted-foreground">{status.message}</p>
      )}
      <DialogFooter>
        {notConfirmed && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </div>
  );
}
