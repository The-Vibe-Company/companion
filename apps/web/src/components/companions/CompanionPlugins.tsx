"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionPluginAccount,
  CompanionPluginCatalogEntry,
  CompanionPluginOAuthStartInput,
  SaveCompanionPluginInput,
} from "@companion/contracts";
import {
  COMPANION_PLUGIN_CATALOG,
  companionPluginOAuthServerNameSchema,
} from "@companion/contracts";
import {
  deleteCompanionPlugin,
  saveCompanionPlugin,
  startCompanionPluginOAuth,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import { PluginMark } from "./PluginMark";

export interface CompanionPluginsApi {
  deleteCompanionPlugin: typeof deleteCompanionPlugin;
  saveCompanionPlugin: typeof saveCompanionPlugin;
  startCompanionPluginOAuth: typeof startCompanionPluginOAuth;
}

const defaultCompanionPluginsApi: CompanionPluginsApi = {
  deleteCompanionPlugin,
  saveCompanionPlugin,
  startCompanionPluginOAuth,
};

function providerName(value: string): string {
  return value
    .split("-")
    .map((part) => part ? part[0]!.toLocaleUpperCase("en-US") + part.slice(1) : part)
    .join(" ");
}

function AddMcpDialog({
  orgId,
  api,
  onAdded,
  onClose,
}: {
  orgId: string;
  api: CompanionPluginsApi;
  onAdded: (account: CompanionPluginAccount) => void;
  onClose: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // Only transport is React-controlled (drives conditional fields). Everything else is a
  // native uncontrolled form so submit reads the live DOM via FormData — the same path a
  // normal browser user and Chrome automation share after real input.
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const nextProvider = String(data.get("provider") ?? "").trim().toLocaleLowerCase("en-US");
    const nextLabel = String(data.get("label") ?? "").trim();
    const nextTransport = data.get("transport") === "stdio" ? "stdio" : "http";
    const nextEndpoint = String(data.get("endpoint") ?? "").trim();
    const nextArgs = String(data.get("args") ?? "").trim();
    const nextCredentialName = String(data.get("credential_name") ?? "").trim();
    const nextCredentialValue = String(data.get("credential_value") ?? "");

    if (busyRef.current) return;

    if (!nextProvider || !nextLabel || !nextEndpoint) {
      setError("Provider, account label, and endpoint are required.");
      return;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(nextProvider)) {
      setError("Provider must be lowercase letters, digits, or hyphens, and start with a letter.");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (nextTransport !== transport) setTransport(nextTransport);

    const credential = nextCredentialValue.trim()
      ? {
          credential_name: nextCredentialName || (nextTransport === "http" ? "Authorization" : "MCP_TOKEN"),
          credential_value: nextCredentialValue,
        }
      : {};
    const input: SaveCompanionPluginInput = nextTransport === "http"
      ? {
          provider: nextProvider,
          label: nextLabel,
          transport: nextTransport,
          url: nextEndpoint,
          args: [],
          ...credential,
        }
      : {
          provider: nextProvider,
          label: nextLabel,
          transport: nextTransport,
          command: nextEndpoint,
          args: nextArgs ? nextArgs.split(/\s+/) : [],
          ...credential,
        };

    try {
      const account = await api.saveCompanionPlugin(orgId, input);
      onAdded(account);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be connected.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="plug-zap"
      title="Add custom MCP"
      desc="Connect one account and give it a short label such as work or personal."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-plugin-dialog"
      foot={(
        <>
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--md"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="companion-plugin-create"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Connecting..." : "Connect MCP"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form
        id="companion-plugin-create"
        ref={formRef}
        className="companions-plugin-form"
        noValidate
        autoComplete="off"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div className="companions-plugin-form__pair">
          <label>
            Provider
            <input
              name="provider"
              autoFocus
              required
              maxLength={63}
              placeholder="e.g. linear"
              title="Lowercase letters, digits, and hyphens; must start with a letter"
              autoComplete="off"
            />
          </label>
          <label>
            Account label
            <input
              name="label"
              required
              maxLength={40}
              placeholder="e.g. work"
              autoComplete="off"
            />
          </label>
        </div>
        <label>
          Transport
          <select
            name="transport"
            value={transport}
            onChange={(event) => {
              const next = event.target.value === "stdio" ? "stdio" : "http";
              setTransport(next);
              const form = formRef.current;
              if (!form) return;
              const endpointInput = form.elements.namedItem("endpoint");
              const argsInput = form.elements.namedItem("args");
              const credNameInput = form.elements.namedItem("credential_name");
              if (endpointInput instanceof HTMLInputElement) endpointInput.value = "";
              if (argsInput instanceof HTMLInputElement) argsInput.value = "";
              if (credNameInput instanceof HTMLInputElement) {
                credNameInput.value = next === "http" ? "Authorization" : "MCP_TOKEN";
              }
            }}
          >
            <option value="http">HTTP</option>
            <option value="stdio">Command (stdio)</option>
          </select>
        </label>
        <label>
          {transport === "http" ? "MCP URL" : "Command"}
          <input
            name="endpoint"
            required
            placeholder={transport === "http" ? "https://mcp.example.com" : "github-mcp-server"}
            autoComplete="off"
          />
        </label>
        {transport === "stdio" && (
          <label>
            Arguments
            <input
              name="args"
              placeholder="stdio"
              autoComplete="off"
            />
          </label>
        )}
        <div className="companions-plugin-form__pair">
          <label>
            {transport === "http" ? "Auth header" : "Secret environment variable"}
            <input
              name="credential_name"
              key={`credential-name-${transport}`}
              defaultValue={transport === "http" ? "Authorization" : "MCP_TOKEN"}
              placeholder={transport === "http" ? "Authorization" : "MCP_TOKEN"}
              autoComplete="off"
            />
          </label>
          <label>
            Credential
            <input
              type="password"
              name="credential_value"
              placeholder="Optional"
              autoComplete="off"
            />
          </label>
        </div>
        <p className="companions-new-form__hint">
          Credentials are write-only and encrypted. Reconnect the account to replace one.
        </p>
      </form>
    </Dialog>
  );
}

/** Connect one product-curated plugin through its brokered OAuth flow. */
function CatalogConnectDialog({
  orgId,
  api,
  server,
  controlLink,
  onClose,
}: {
  orgId: string;
  api: CompanionPluginsApi;
  server: CompanionPluginCatalogEntry;
  controlLink: { companionId: string; requestId: string } | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setError("An account label is required.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let redirecting = false;
    try {
      const oauthInput: CompanionPluginOAuthStartInput = {
        server_name: companionPluginOAuthServerNameSchema.parse(server.server_name),
        label: trimmed,
      };
      if (controlLink) {
        oauthInput.companion_id = controlLink.companionId;
        oauthInput.control_request_id = controlLink.requestId;
      }
      const authorizationUrl = await api.startCompanionPluginOAuth(orgId, oauthInput);
      window.location.assign(authorizationUrl);
      redirecting = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be connected.");
    } finally {
      if (!redirecting) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Dialog
      icon={<PluginMark provider={server.provider} size="md" variant="glyph" />}
      title={`Connect ${server.title}`}
      desc={server.provider === "github"
        ? "Give this account a short label such as work or personal. The same OAuth grant also makes GitHub trigger registration available member-wide."
        : server.provider === "sentry"
          ? "Give this account a short label. The same OAuth grant powers Sentry MCP tools and member-wide trigger registration."
        : server.provider === "gmail"
          ? "Give this account a short label such as work or personal. Gmail can read and search mail, then create drafts for you to review in Gmail. It never sends email."
        : "Give this account a short label such as work or personal."}
      onClose={onClose}
      closeDisabled={busy}
      className={`og-dialog companions-plugin-dialog companions-plugin-dialog--${server.provider}`}
      foot={(
        <>
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--md"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="companion-catalog-connect"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Connecting..." : "Continue with OAuth"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form
        id="companion-catalog-connect"
        className="companions-plugin-form"
        noValidate
        autoComplete="off"
        onSubmit={(event) => void onSubmit(event)}
      >
        <label>
          Account label
          <input
            value={label}
            autoFocus
            required
            maxLength={40}
            placeholder="e.g. work"
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <p className="companions-new-form__hint">
          {server.provider === "github"
            ? "Authorize GitHub once. Trigger registration is immediately available to every Companion; GitHub MCP tools still require per-Companion attachment. Tokens remain write-only and encrypted."
            : server.provider === "sentry"
              ? "Authorize Sentry once. Trigger registration is immediately available to every Companion; Sentry MCP tools still require per-Companion attachment. Tokens remain write-only and encrypted."
            : server.provider === "gmail"
              ? "Authorize read and draft access on Google. Companion cannot send mail; every draft stays in Gmail for your review. Tokens remain write-only and encrypted."
            : "You will authorize this account on the provider's website. Tokens remain write-only and encrypted."}
        </p>
      </form>
    </Dialog>
  );
}

function CatalogPluginCard({
  server,
  connectedCount,
  onConnect,
}: {
  server: CompanionPluginCatalogEntry;
  connectedCount: number;
  onConnect: (server: CompanionPluginCatalogEntry) => void;
}) {
  return (
    <article className="companions-catalog-card">
      <PluginMark provider={server.provider} size="md" />
      <div className="companions-catalog-card__body">
        <strong>
          {server.title}
          {connectedCount > 0 && (
            <span className="companions-catalog-card__count">
              {connectedCount === 1 ? "1 account" : `${connectedCount} accounts`}
            </span>
          )}
        </strong>
        {server.description && <p>{server.description}</p>}
      </div>
      <button
        type="button"
        className="cds-btn cds-btn--secondary cds-btn--sm"
        onClick={() => onConnect(server)}
      >
        {connectedCount > 0 ? "Add account" : "Connect"}
      </button>
    </article>
  );
}

export function CompanionPlugins({
  orgId,
  initialAccounts,
  onBack,
  onAccountsChange,
  api = defaultCompanionPluginsApi,
}: {
  orgId: string;
  initialAccounts: CompanionPluginAccount[];
  onBack: () => void;
  onAccountsChange?: (accounts: CompanionPluginAccount[]) => void;
  api?: CompanionPluginsApi;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState<CompanionPluginCatalogEntry | null>(null);
  const [controlLink, setControlLink] = useState<{ companionId: string; requestId: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oauthNotice, setOauthNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const requestedProvider = url.searchParams.get("connect");
    const companionId = url.searchParams.get("control_companion");
    const requestId = url.searchParams.get("control_request");
    const requestedServer = requestedProvider
      ? COMPANION_PLUGIN_CATALOG.find((server) => server.provider === requestedProvider)
      : undefined;
    if (requestedServer && companionId && requestId) {
      setConnecting(requestedServer);
      setControlLink({ companionId, requestId });
    }
    if (url.searchParams.get("oauth") === "connected") {
      setOauthNotice({
        tone: "success",
        message: url.searchParams.get("provider") === "github"
          ? "GitHub connected. Trigger registration is live for every Companion; MCP tools can now be attached separately."
          : url.searchParams.get("provider") === "sentry"
            ? "Sentry connected. Trigger registration is live for every Companion; MCP tools can now be attached separately."
          : url.searchParams.get("provider") === "gmail"
            ? "Gmail connected for reading and drafts."
            : "MCP account connected.",
      });
    } else {
      const oauthError = url.searchParams.get("oauth_error");
      if (oauthError) {
        setOauthNotice({
          tone: "error",
          message: oauthError === "duplicate_label"
            ? "That provider already has an account with this label."
            : "OAuth authorization did not complete. Try connecting again.",
        });
      }
    }
    if (url.searchParams.has("oauth") || url.searchParams.has("oauth_error")) {
      url.searchParams.delete("oauth");
      url.searchParams.delete("oauth_error");
      url.searchParams.delete("provider");
      url.searchParams.delete("connect");
      url.searchParams.delete("control_companion");
      url.searchParams.delete("control_request");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return () => {
      const current = new URL(window.location.href);
      const before = current.search;
      current.searchParams.delete("connect");
      current.searchParams.delete("control_companion");
      current.searchParams.delete("control_request");
      if (current.search !== before) {
        window.history.replaceState(null, "", `${current.pathname}${current.search}${current.hash}`);
      }
    };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, CompanionPluginAccount[]>();
    for (const account of accounts) {
      grouped.set(account.provider, [...(grouped.get(account.provider) ?? []), account]);
    }
    return [...grouped.entries()];
  }, [accounts]);

  const connectedByProvider = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
    }
    return counts;
  }, [accounts]);

  const closeConnection = () => {
    setConnecting(null);
    setControlLink(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("connect");
    url.searchParams.delete("control_companion");
    url.searchParams.delete("control_request");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const leavePlugins = () => {
    closeConnection();
    onBack();
  };

  const remove = async (account: CompanionPluginAccount) => {
    const confirmed = window.confirm(
      `Disconnect ${providerName(account.provider)} “${account.label}”? `
      + "This member-wide account will be unavailable to every Companion. Its MCP tool attachments "
      + "will stop working, and triggers that use it cannot register or receive events until the provider is reconnected.",
    );
    if (!confirmed) return;
    setRemoving(account.id);
    setError(null);
    try {
      await api.deleteCompanionPlugin(orgId, account.id);
      const next = accounts.filter((item) => item.id !== account.id);
      setAccounts(next);
      onAccountsChange?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be disconnected.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="companions-plugins" aria-labelledby="plugins-title">
      <header className="companions-head companions-plugins__head">
        <div className="companions-plugins__title">
          <button type="button" className="iconbtn" aria-label="Back to Companions" onClick={leavePlugins}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 id="plugins-title">Plugins</h1>
            <p>Connect approved plugins or add a custom MCP server.</p>
          </div>
        </div>
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--md"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={15} /> Add custom MCP
        </button>
      </header>

      <div className="companions-content">
        {oauthNotice?.tone === "success" && (
          <p className="companions-catalog-note" role="status">{oauthNotice.message}</p>
        )}
        {oauthNotice?.tone === "error" && (
          <div className="companions-error" role="alert">{oauthNotice.message}</div>
        )}
        {error && <div className="companions-error" role="alert">{error}</div>}

        <section className="companions-plugin-section" aria-label="Connected accounts">
          <h2 className="companions-plugin-section__title">
            Connected
            {accounts.length > 0 && (
              <span className="companions-plugin-section__count">{accounts.length}</span>
            )}
          </h2>
          {groups.length === 0 ? (
            <div className="companions-plugin-empty">
              <p>No plugins connected yet.</p>
              <p>Connect Linear, GitHub, Notion, Conductor, Slack, Gmail, or Sentry below, or add a custom MCP server.</p>
            </div>
          ) : (
            <div className="companions-plugin-list">
              {groups.map(([provider, providerAccounts]) => (
                <section className="companions-plugin-row" key={provider}>
                  <PluginMark provider={provider} />
                  <strong>{providerName(provider)}</strong>
                  <span className="companions-state companions-state--ok">
                    <i aria-hidden="true" /> Connected
                  </span>
                  <div className="companions-plugin-labels">
                    {providerAccounts.map((account) => (
                      <span className="companions-plugin-label" key={account.id}>
                        <span>{account.label}</span>
                        <button
                          type="button"
                          aria-label={`Disconnect ${providerName(provider)} ${account.label}`}
                          disabled={removing === account.id}
                          onClick={() => void remove(account)}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <section className="companions-plugin-section" aria-label="Available plugins">
          <h2 className="companions-plugin-section__title">Available plugins</h2>
          <div className="companions-catalog-grid">
            {COMPANION_PLUGIN_CATALOG.map((server) => (
              <CatalogPluginCard
                key={server.server_name}
                server={server}
                connectedCount={connectedByProvider.get(server.provider) ?? 0}
                onConnect={setConnecting}
              />
            ))}
          </div>
        </section>
      </div>

      {adding && (
        <AddMcpDialog
          orgId={orgId}
          api={api}
          onAdded={(account) => {
            const next = [...accounts, account];
            setAccounts(next);
            onAccountsChange?.(next);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {connecting && (
        <CatalogConnectDialog
          orgId={orgId}
          api={api}
          server={connecting}
          controlLink={controlLink}
          onClose={closeConnection}
        />
      )}
    </section>
  );
}
