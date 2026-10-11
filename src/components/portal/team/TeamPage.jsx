"use client";

/**
 * /portal/team: owners invite teammates, see members and pending invites,
 * and remove people. Mirrors GET/POST/DELETE /api/customer/team.
 */

import { useCallback, useEffect, useState } from "react";
import { Trash2, UserPlus, Users } from "lucide-react";
import { usePortal } from "../PortalShell";
import { Badge, Banner, Button, Card, PageHeader, SkeletonRows, formatRelative } from "../ui";
import "./team.css";

const JSON_HEADERS = { "Content-Type": "application/json" };

function initialOf(email) {
  return (email || "?").trim().slice(0, 1).toUpperCase() || "?";
}

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
    if (!window.confirm(`Remove ${label} from this workspace? They will lose access right away.`)) return;
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
    <div className="pv-page">
      <PageHeader title="Team" description="People who can see this workspace." />

      {!isOwner ? (
        <Banner tone="info">Only workspace owners can manage the team.</Banner>
      ) : (
        <div className="pv-stack">
          {banner ? (
            <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>
          ) : null}

          <Card title="Invite a teammate" description="They receive an email with a link to join this workspace.">
            <form className="pv-team-invite" onSubmit={sendInvite}>
              <label className="sr-only" htmlFor="pv-team-invite-email">Email address</label>
              <input
                id="pv-team-invite-email"
                className="pv-input pv-team-invite__input"
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
                  <div className="pv-table-wrap">
                    <table className="pv-table pv-team-table">
                      <thead>
                        <tr>
                          <th scope="col">Member</th>
                          <th scope="col">Role</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {team.members.map((member) => {
                          const isSelf = member.user_id === user?.id;
                          return (
                            <tr key={member.user_id}>
                              <td>
                                <div className="pv-team-person">
                                  <span className="pv-team-avatar" aria-hidden="true">{initialOf(member.email)}</span>
                                  <span className="pv-team-person__text">
                                    <span className="pv-team-person__email">{member.email || "Unknown address"}</span>
                                    {isSelf ? <span className="pv-team-person__you">(you)</span> : null}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <Badge tone={member.role === "owner" ? "brand" : "neutral"}>
                                  {member.role === "owner" ? "Owner" : "Member"}
                                </Badge>
                              </td>
                              <td className="pv-team-table__action">
                                {!isSelf ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={Trash2}
                                    className="pv-team-remove"
                                    loading={removingId === member.user_id}
                                    disabled={!!removingId}
                                    onClick={() => removeMember(member)}
                                  >
                                    Remove
                                  </Button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="pv-team-empty"><Users aria-hidden="true" />No members yet.</div>
                )}
              </Card>

              {team.pending_invites?.length ? (
                <Card title="Pending invites" description="Waiting for the recipient to accept." flush>
                  <div className="pv-table-wrap">
                    <table className="pv-table pv-team-table">
                      <thead>
                        <tr>
                          <th scope="col">Email</th>
                          <th scope="col">Role</th>
                          <th scope="col">Sent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {team.pending_invites.map((invite) => (
                          <tr key={invite.id}>
                            <td>
                              <div className="pv-team-person">
                                <span className="pv-team-avatar pv-team-avatar--pending" aria-hidden="true">{initialOf(invite.email)}</span>
                                <span className="pv-team-person__email">{invite.email}</span>
                              </div>
                            </td>
                            <td>
                              <Badge tone={invite.role === "owner" ? "brand" : "neutral"}>
                                {invite.role === "owner" ? "Owner" : "Member"}
                              </Badge>
                            </td>
                            <td className="pv-muted">{invite.created_at ? `Invite sent ${formatRelative(invite.created_at)}` : "Invite sent"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
