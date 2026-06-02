// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---- Mock API ----
const mockVerifyAuthToken = vi.fn().mockResolvedValue(true);
const mockAutoAuth = vi.fn().mockResolvedValue(null);

vi.mock("../api.js", () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
  autoAuth: () => mockAutoAuth(),
}));

// ---- Mock Store ----
interface MockStoreState {
  setAuthToken: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    setAuthToken: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { LoginPage } from "./LoginPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Clear any URL params between tests
  window.history.replaceState({}, "", window.location.pathname);
});

describe("LoginPage", () => {
  it("renders the login form with title, input, and submit button", () => {
    // The login page should display the app title, a token input field,
    // a submit button, and help text about scanning QR with native camera
    render(<LoginPage />);

    expect(screen.getByText("The Companion")).toBeInTheDocument();
    expect(screen.getByLabelText("Auth Token")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste your token here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByText(/Scan the QR code/)).toBeInTheDocument();
  });

  it("disables submit button when input is empty", () => {
    // The Login button should be disabled when no token is entered
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: "Login" })).toBeDisabled();
  });

  it("enables submit button when token is entered", () => {
    // Typing a token should enable the Login button
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "test-token-123" },
    });

    expect(screen.getByRole("button", { name: "Login" })).toBeEnabled();
  });

  it("calls verifyAuthToken and setAuthToken on successful submit", async () => {
    // Submitting a valid token should verify it via API and then store it
    mockVerifyAuthToken.mockResolvedValue(true);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "valid-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(mockVerifyAuthToken).toHaveBeenCalledWith("valid-token");
      expect(mockState.setAuthToken).toHaveBeenCalledWith("valid-token");
    });
  });

  it("shows error message when token verification fails", async () => {
    // An invalid token should display an error and not call setAuthToken
    mockVerifyAuthToken.mockResolvedValue(false);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "bad-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid token");
    });
    expect(mockState.setAuthToken).not.toHaveBeenCalled();
  });

  it("shows 'Verifying...' while submit is in progress", async () => {
    // The button text should change during verification to indicate loading
    let resolveVerify!: (v: boolean) => void;
    mockVerifyAuthToken.mockReturnValue(
      new Promise<boolean>((r) => { resolveVerify = r; }),
    );
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "some-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    // Should show loading state
    expect(screen.getByRole("button", { name: "Verifying..." })).toBeDisabled();

    // Resolve and check loading goes away
    resolveVerify(false);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    });
  });

  it("shows empty-token error when submitting whitespace-only input", async () => {
    // Submitting only spaces should show a validation error without calling the API
    render(<LoginPage />);

    const input = screen.getByLabelText("Auth Token");
    // Need to type something to enable the button behavior check
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Please enter a token");
    });
    expect(mockVerifyAuthToken).not.toHaveBeenCalled();
  });

  it("clears error when user types after a failed attempt", async () => {
    // Typing new input should clear the previous error message
    mockVerifyAuthToken.mockResolvedValue(false);
    render(<LoginPage />);

    // First: trigger an error
    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Then: type again to clear the error
    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "new-attempt" },
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("toggles password visibility when Show/Hide is clicked", () => {
    // The Show/Hide button should toggle the input type between password and text
    render(<LoginPage />);

    const input = screen.getByLabelText("Auth Token");
    expect(input).toHaveAttribute("type", "password");

    // Click "Show" to reveal the token
    fireEvent.click(screen.getByText("Show"));
    expect(input).toHaveAttribute("type", "text");

    // Click "Hide" to mask it again
    fireEvent.click(screen.getByText("Hide"));
    expect(input).toHaveAttribute("type", "password");
  });
});

describe("LoginPage localhost auto-auth", () => {
  it("auto-authenticates on localhost without user interaction", async () => {
    // When the server detects a localhost request, it returns the token
    // so the user never sees the login form on first launch
    mockAutoAuth.mockResolvedValue("localhost-auto-token");
    render(<LoginPage />);

    await waitFor(() => {
      expect(mockAutoAuth).toHaveBeenCalled();
      expect(mockState.setAuthToken).toHaveBeenCalledWith("localhost-auto-token");
    });
  });

  it("falls back to URL token when auto-auth returns null (remote access)", async () => {
    // On remote connections, auto-auth returns null — then ?token= is checked
    mockAutoAuth.mockResolvedValue(null);
    window.history.replaceState({}, "", "/?token=url-token-abc");
    mockVerifyAuthToken.mockResolvedValue(true);

    render(<LoginPage />);

    await waitFor(() => {
      expect(mockVerifyAuthToken).toHaveBeenCalledWith("url-token-abc");
      expect(mockState.setAuthToken).toHaveBeenCalledWith("url-token-abc");
    });
  });
});

describe("LoginPage auto-login from URL", () => {
  it("auto-authenticates when ?token= is present in the URL", async () => {
    // When the page loads with ?token=xxx (e.g. from a QR code scanned with
    // the native iPhone camera), it should auto-verify and login
    mockAutoAuth.mockResolvedValue(null);
    window.history.replaceState({}, "", "/?token=url-token-abc");
    mockVerifyAuthToken.mockResolvedValue(true);

    render(<LoginPage />);

    await waitFor(() => {
      expect(mockVerifyAuthToken).toHaveBeenCalledWith("url-token-abc");
      expect(mockState.setAuthToken).toHaveBeenCalledWith("url-token-abc");
    });
  });

  it("shows error when URL token is invalid", async () => {
    // An invalid URL token should display an error message
    mockAutoAuth.mockResolvedValue(null);
    window.history.replaceState({}, "", "/?token=invalid-url-token");
    mockVerifyAuthToken.mockResolvedValue(false);

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid token from URL");
    });
    expect(mockState.setAuthToken).not.toHaveBeenCalled();
  });
});

describe("LoginPage accessibility", () => {
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<LoginPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with error displayed", async () => {
    // The error state should also be accessible
    const { axe } = await import("vitest-axe");
    mockVerifyAuthToken.mockResolvedValue(false);
    const { container } = render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Auth Token"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
