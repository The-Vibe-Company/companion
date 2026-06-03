package execx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type Runner interface {
	Run(ctx context.Context, command []string) (Result, error)
}

type ShellRunner struct {
	Dir string
	Env map[string]string
}

func (r ShellRunner) Run(ctx context.Context, command []string) (Result, error) {
	if len(command) == 0 {
		return Result{ExitCode: 1}, fmt.Errorf("empty command")
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	if r.Dir != "" {
		cmd.Dir = r.Dir
	}
	if len(r.Env) > 0 {
		cmd.Env = os.Environ()
		for key, value := range r.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0}
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exit.ExitCode()
			return result, nil
		}
		result.ExitCode = 1
		return result, err
	}
	return result, nil
}

func Quote(command []string) string {
	parts := make([]string, len(command))
	for i, part := range command {
		if strings.ContainsAny(part, " \t\n\"'") {
			parts[i] = fmt.Sprintf("%q", part)
		} else {
			parts[i] = part
		}
	}
	return strings.Join(parts, " ")
}

type FakeRunner struct {
	Responses map[string]Result
	Errors    map[string]error
	Calls     [][]string
}

func (r *FakeRunner) Run(_ context.Context, command []string) (Result, error) {
	r.Calls = append(r.Calls, append([]string(nil), command...))
	if r.Errors != nil {
		if err, ok := r.Errors[strings.Join(command, "\x00")]; ok {
			return Result{}, err
		}
		if err, ok := r.Errors[Quote(command)]; ok {
			return Result{}, err
		}
	}
	if r.Responses == nil {
		return Result{}, nil
	}
	if result, ok := r.Responses[strings.Join(command, "\x00")]; ok {
		return result, nil
	}
	if result, ok := r.Responses[Quote(command)]; ok {
		return result, nil
	}
	return Result{}, nil
}
