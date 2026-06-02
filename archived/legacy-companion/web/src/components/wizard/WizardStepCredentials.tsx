import { useState } from "react";
import { api } from "../../api.js";

interface WizardStepCredentialsProps {
  onNext: () => void;
  onBack: () => void;
  credentialsSaved: boolean;
  onCredentialsSaved: (stagingId: string) => void;
}

export function WizardStepCredentials({ onNext, onBack, credentialsSaved, onCredentialsSaved }: WizardStepCredentialsProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(credentialsSaved);

  async function handleSave() {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    const trimmedWebhook = webhookSecret.trim();

    if (!trimmedId || !trimmedSecret || !trimmedWebhook) {
      setError("All three fields are required.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      // Create a per-wizard staging slot instead of writing to global settings
      const result = await api.createLinearStaging({
        clientId: trimmedId,
        clientSecret: trimmedSecret,
        webhookSecret: trimmedWebhook,
      });
      setSaved(true);
      onCredentialsSaved(result.stagingId);
      setClientId("");
      setClientSecret("");
      setWebhookSecret("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-cc-fg">Enter OAuth Credentials</h2>
        <p className="mt-1 text-sm text-cc-muted">
          Copy the Client ID, Client Secret, and Webhook Signing Secret from your Linear OAuth app.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-client-id">
            Client ID
          </label>
          <input
            id="wizard-client-id"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={saved ? "Saved — enter new value to update" : "OAuth app client ID"}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-client-secret">
            Client Secret
          </label>
          <input
            id="wizard-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={saved ? "Saved — enter new value to update" : "OAuth app client secret"}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-webhook-secret">
            Webhook Signing Secret
          </label>
          <input
            id="wizard-webhook-secret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={saved ? "Saved — enter new value to update" : "Webhook signing secret from Linear"}
            className={inputClass}
          />
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      {saved && !clientId && !clientSecret && !webhookSecret && (
        <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
          Credentials saved successfully.
        </div>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Back
        </button>
        <div className="flex gap-2">
          {/* Show Save button when credentials haven't been saved yet, or when the user
              has typed new values (allowing corrections after the first save) */}
          {(!saved || (clientId.trim() && clientSecret.trim() && webhookSecret.trim())) && (
            <button
              onClick={handleSave}
              disabled={saving || !clientId.trim() || !clientSecret.trim() || !webhookSecret.trim()}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                saving || !clientId.trim() || !clientSecret.trim() || !webhookSecret.trim()
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {saving ? "Saving..." : saved ? "Update Credentials" : "Save Credentials"}
            </button>
          )}
          {saved && (
            <button
              onClick={onNext}
              className="px-4 py-2.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
