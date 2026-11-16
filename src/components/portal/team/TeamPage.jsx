"use client";

/**
 * /portal/team: owners invite teammates, see members and pending invites,
 * and remove people. Mirrors GET/POST/DELETE /api/customer/team.
 */

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { usePortal } from "../PortalShell";
import { Badge, Banner, Button, Card, PageHeader, SkeletonRows, formatRelative } from "../ui";
import { InlineConfirm } from "@/components/app/InlineConfirm";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const JSON_HEADERS = { "Content-Type": "application/json" };

function initialOf(email) {
  return (email || "?").trim().slice(0, 1).toUpperCase() || "?";
}

const AVATAR_CLASSES =
  "grid size-[30px] shrink-0 place-items-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground";

export default function TeamPage() {
  const { brandKey, isOwner, user, redirectToLogin } = usePortal();

  const [team, setTeam] = useState(null); // { members, pending_invites }
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState(null); // { tone, text }
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState("");

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/customer/team?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load team members.");
      setTeam(body);
    } catch (failure) {
      setLoadError(failure.message || "Could not load team members.");
    } finally {
      setLoading(false);
    }
  }, [brandKey, redirectToLogin]);

  useEffect(() => {
    if (isOwner) loadTeam();
  }, [isOwner, loadTeam]);

  async function sendInvite(event) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setInviting(true);
    setBanner(null);
    try {
      const response = await fetch("/api/customer/team", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ brand_key: brandKey, email: address }),
      });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not invite this person.");
      setBanner({
        tone: "success",
        text: body.added ? `${address} already has an account and was added to the workspace.` : `Invite sent to ${address}.`,
      });
      setEmail("");
      await loadTeam();
    } catch (failure) {
      setBanner({ tone: "error", text: failure.message || "Could not invite this person." });
    } finally {
      setInviting(false);
    }
  }

  async function removeMember(member) {
    const label = member.email || "this member";
    setRemovingId(member.user_id);
    setBanner(null);
    try {
      const response = await fetch("/api/customer/team", {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ brand_key: brandKey, user_id: member.user_id }),
      });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not remove this team member.");
      setBanner({ tone: "success", text: `${label} was removed from the workspace.` });
      await loadTeam();
    } catch (failure) {
      setBanner({ tone: "error", text: failure.message || "Could not remove this team member." });
    } finally {
      setRemovingId("");
    }
  }

  return (
    <>
      <PageHeader title="Team" description="People who can see this workspace." />

      {!isOwner ? (
        <Banner tone="info">Only workspace owners can manage the team.</Banner>
      ) : (
        <div className="space-y-5">
          {banner ? (
            <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>
          ) : null}

          <Card title="Invite a teammate" description="They receive an email with a link to join this workspace.">
            <form className="flex flex-wrap items-center gap-2" onSubmit={sendInvite}>
              <label className="sr-only" htmlFor="pv-team-invite-email">Email address</label>
              <Input
                id="pv-team-invite-email"
                className="max-w-md flex-1 basis-64"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="colleague@company.com"
                autoComplete="off"
                required
              />
              <Button type="submit" icon={UserPlus} loading={inviting} disabled={!email.trim()}>
                Send invite
              </Button>
            </form>
          </Card>

          {loadError ? (
            <Banner tone="error" action={<Button variant="secondary" size="sm" onClick={loadTeam}>Retry</Button>}>
              {loadError}
            </Banner>
          ) : null}

          {loading && !team ? (
            <Card title="Members"><SkeletonRows rows={3} /></Card>
          ) : null}

          {team ? (
            <>
              <Card title="Members" description={`${team.members?.length || 0} with access`} flush>
                {team.members?.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Member</TableHead>
                        <TableHead scope="col">Role</TableHead>
                        <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {team.members.map((member) => {
                        const isSelf = member.user_id === user?.id;
                        const address = member.email || "this member";
                        return (
                          <TableRow key={member.user_id}>
                            <TableCell>
                              <div className="flex min-w-0 items-center gap-3">
                                <span className={AVATAR_CLASSES} aria-hidden="true">{initialOf(member.email)}</span>
                                <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                                  <span className="truncate font-medium text-foreground">{member.email || "Unknown address"}</span>
                                  {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge tone={member.role === "owner" ? "brand" : "neutral"}>
                                {member.role === "owner" ? "Owner" : "Member"}
                              </Badge>
                            </TableCell>
                            <TableCell className="w-px whitespace-nowrap text-right">
                              {!isSelf ? (
                                <InlineConfirm
                                  label={`Remove ${address}`}
                                  pending={removingId === member.user_id}
                                  disabled={!!removingId && removingId !== member.user_id}
                                  onConfirm={() => removeMember(member)}
                                />
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="flex items-center justify-center gap-2 px-4 py-7 text-sm text-muted-foreground">
                    <Users aria-hidden="true" className="size-4" />No members yet.
                  </div>
                )}
              </Card>

              {team.pending_invites?.length ? (
                <Card title="Pending invites" description="Waiting for the recipient to accept." flush>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Email</TableHead>
                        <TableHead scope="col">Role</TableHead>
                        <TableHead scope="col">Sent</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {team.pending_invites.map((invite) => (
                        <TableRow key={invite.id}>
                          <TableCell>
                            <div className="flex min-w-0 items-center gap-3">
                              <span className={AVATAR_CLASSES + " border-dashed bg-card text-muted-foreground"} aria-hidden="true">{initialOf(invite.email)}</span>
                              <span className="truncate font-medium text-foreground">{invite.email}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge tone={invite.role === "owner" ? "brand" : "neutral"}>
                              {invite.role === "owner" ? "Owner" : "Member"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{invite.created_at ? `Invite sent ${formatRelative(invite.created_at)}` : "Invite sent"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
