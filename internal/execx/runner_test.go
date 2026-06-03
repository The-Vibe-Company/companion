package execx

import (
	"context"
	"testing"
)

func TestShellRunnerInjectsEnvironment(t *testing.T) {
	result, err := (ShellRunner{Env: map[string]string{"COMPANION_TEST_VALUE": "from-env-file"}}).Run(context.Background(), []string{"sh", "-c", `printf %s "$COMPANION_TEST_VALUE"`})
	if err != nil {
		t.Fatalf("run shell: %v", err)
	}
	if result.Stdout != "from-env-file" {
		t.Fatalf("unexpected stdout: %q", result.Stdout)
	}
}
