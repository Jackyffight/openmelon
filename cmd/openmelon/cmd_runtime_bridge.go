package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/eight-acres-lab/openmelon/internal/hooks"
	"github.com/eight-acres-lab/openmelon/internal/imagegen"
	"github.com/eight-acres-lab/openmelon/internal/llm"
	"github.com/eight-acres-lab/openmelon/internal/projectx"
	"github.com/eight-acres-lab/openmelon/internal/runtime"
	"github.com/eight-acres-lab/openmelon/internal/session"
	"github.com/eight-acres-lab/openmelon/internal/skillplus"
	"github.com/eight-acres-lab/openmelon/internal/tools"
	"github.com/eight-acres-lab/openmelon/internal/userconfig"
)

type bridgeRequest struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ID       string `json:"id,omitempty"`
	Approved bool   `json:"approved,omitempty"`
	Always   bool   `json:"always,omitempty"`
}

type bridgeEvent struct {
	Type             string         `json:"type"`
	Kind             string         `json:"kind,omitempty"`
	Text             string         `json:"text,omitempty"`
	Status           string         `json:"status,omitempty"`
	Activity         string         `json:"activity,omitempty"`
	PromptTokens     int            `json:"promptTokens,omitempty"`
	CompletionTokens int            `json:"completionTokens,omitempty"`
	TotalTokens      int            `json:"totalTokens,omitempty"`
	SessionID        string         `json:"sessionId,omitempty"`
	SessionDir       string         `json:"sessionDir,omitempty"`
	Model            string         `json:"model,omitempty"`
	Reasoning        string         `json:"reasoning,omitempty"`
	Project          string         `json:"project,omitempty"`
	Provider         string         `json:"provider,omitempty"`
	Error            string         `json:"error,omitempty"`
	Detail           map[string]any `json:"detail,omitempty"`
}

type bridgeRuntime struct {
	wd           string
	project      *projectx.Project
	rt           *runtime.Runtime
	session      *session.Session
	systemPrompt string
	history      []llm.Message
	persisted    int
	imgGen       imagegen.Generator
	allowedBins  map[string]bool
	out          *json.Encoder
	outMu        sync.Mutex
	pendingMu    sync.Mutex
	pending      []string
	cancelMu     sync.Mutex
	cancel       context.CancelFunc
	running      bool
	approvalMu   sync.Mutex
	approvals    map[string]chan tools.ApprovalDecision
	approvalSeq  int
}

func runRuntimeBridge(args []string) error {
	resume := ""
	if len(args) > 0 {
		resume = strings.TrimSpace(args[0])
	}
	br, err := newBridgeRuntime(resume)
	if err != nil {
		enc := json.NewEncoder(os.Stdout)
		msg := err.Error()
		_ = enc.Encode(bridgeEvent{Type: "append", Kind: "error", Text: msg, Error: msg})
		_ = enc.Encode(bridgeEvent{Type: "status", Status: "error", Activity: "Runtime unavailable"})
		return runFailedBridgeLoop(enc, msg)
	}
	defer br.session.Close()

	br.emit(bridgeEvent{
		Type:       "ready",
		Status:     "ready",
		Activity:   "Ready",
		SessionID:  br.session.ID,
		SessionDir: br.session.Dir,
		Model:      br.rtModel(),
		Reasoning:  br.rt.ReasoningEffort,
		Project:    br.project.ID,
		Provider:   br.rtProvider(),
	})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var req bridgeRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			br.emitError(fmt.Errorf("bad request: %w", err))
			continue
		}
		switch req.Type {
		case "run":
			text := strings.TrimSpace(req.Text)
			if text == "" {
				continue
			}
			if br.isRunning() {
				br.addPending(text)
				br.emit(bridgeEvent{Type: "append", Kind: "info", Text: "queued pending input"})
				continue
			}
			br.runTurn(text)
		case "pending":
			text := strings.TrimSpace(req.Text)
			if text != "" {
				br.addPending(text)
			}
		case "cancel":
			br.cancelRun()
		case "clear":
			br.clearHistory()
		case "history":
			br.emitHistory()
		case "save":
			br.saveHistory(req.Text)
		case "reload":
			if err := br.reloadProjectRuntime(); err != nil {
				br.emit(bridgeEvent{Type: "append", Kind: "error", Text: "reload: " + err.Error(), Error: err.Error()})
				br.emit(bridgeEvent{Type: "status", Status: "error", Activity: "Reload failed"})
			}
		case "approval":
			br.answerApproval(req.ID, tools.ApprovalDecision{Approved: req.Approved, Always: req.Always})
		case "shutdown":
			br.cancelRun()
			return nil
		default:
			br.emitError(fmt.Errorf("unknown request type %q", req.Type))
		}
	}
	return scanner.Err()
}

func runFailedBridgeLoop(enc *json.Encoder, msg string) error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var req bridgeRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			_ = enc.Encode(bridgeEvent{Type: "append", Kind: "error", Text: "bad request: " + err.Error(), Error: err.Error()})
			continue
		}
		if req.Type == "shutdown" {
			return nil
		}
		_ = enc.Encode(bridgeEvent{Type: "append", Kind: "error", Text: msg, Error: msg})
		_ = enc.Encode(bridgeEvent{Type: "done"})
	}
	return scanner.Err()
}

func newBridgeRuntime(resume string) (*bridgeRuntime, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	wd, err := projectx.Discover(cwd)
	if err != nil {
		return nil, err
	}
	if wd == "" {
		return nil, errors.New("no openmelon project found — run `openmelon init` or `openmelon setup` first")
	}
	proj, err := projectx.Load(wd)
	if err != nil {
		return nil, err
	}
	if err := projectx.EnsureGitignore(wd); err != nil {
		fmt.Fprintf(os.Stderr, "openmelon: warning: could not write .gitignore: %v\n", err)
	}

	llmProvider, llmModel, imageProvider, imageModel := resolveDefaults(proj)
	if llmProvider == "" {
		llmProvider = "auto"
	}
	if imageProvider == "" {
		imageProvider = "openrouter"
	}
	apiKey := ""
	llmBaseURL := ""
	if llmProvider != "auto" {
		resolved := userconfig.ResolveProvider(wd, llmProvider)
		apiKey = resolved.APIKey
		llmBaseURL = resolved.BaseURL
	}
	llmClient, err := llm.New(llmProvider, apiKey, llmBaseURL, llmModel)
	if err != nil {
		switch {
		case errors.Is(err, llm.ErrNoAPIKey):
			return nil, fmt.Errorf("no API key for %s — run `openmelon setup` to configure", llmProvider)
		case errors.Is(err, llm.ErrModelRequired):
			return nil, fmt.Errorf("no LLM model — run `openmelon setup` to configure")
		}
		return nil, fmt.Errorf("init LLM: %w", err)
	}
	tc, ok := llmClient.(llm.ToolCaller)
	if !ok {
		return nil, fmt.Errorf("provider %q does not support tool calls", llmClient.Provider())
	}
	llmProvider = llmClient.Provider()
	llmModel = llmClient.Model()

	var imgGen imagegen.Generator
	if imageModel != "" {
		imgResolved := userconfig.ResolveProvider(wd, imageProvider)
		imgGen, err = imagegen.New(imageProvider, imgResolved.APIKey, imgResolved.BaseURL, imageModel)
		if err != nil {
			fmt.Fprintf(os.Stderr, "openmelon: image generation disabled (%v)\n", err)
		}
	}

	rt := &runtime.Runtime{
		LLM:             tc,
		MaxSteps:        24,
		ReasoningEffort: resolveReasoningEffort(proj, llmProvider, llmModel),
	}

	intent := fmt.Sprintf("ts tui bridge %s", time.Now().UTC().Format("2006-01-02 15:04"))
	if resume != "" {
		intent = fmt.Sprintf("resumed from %s · %s", resume, intent)
	}
	sess, err := session.NewResume(wd, proj.ID, intent, resume)
	if err != nil {
		return nil, fmt.Errorf("bridge session: %w", err)
	}
	_ = sess.SetRuntimeInfo(llmProvider, llmModel)
	rt.Hooks = hooks.ChainManagers(rt.Hooks, sess.HookRecorder())

	sessionOutputDir := projectx.SessionOutputDir(wd, filepath.Base(sess.Dir))
	br := &bridgeRuntime{
		wd:           wd,
		project:      proj,
		rt:           rt,
		session:      sess,
		systemPrompt: "",
		imgGen:       imgGen,
		allowedBins:  map[string]bool{},
		out:          json.NewEncoder(os.Stdout),
		approvals:    map[string]chan tools.ApprovalDecision{},
	}
	br.rebuildToolsEnv(sessionOutputDir)

	probe := tools.NewRegistry()
	tools.RegisterAll(probe, &tools.Env{
		Workdir:   wd,
		Project:   proj,
		OutputDir: projectx.OutputDir(wd),
		Compiler:  &skillplus.Compiler{},
		ImageGen:  br.imgGen,
	})

	br.systemPrompt = buildProjectSystemPrompt(proj, probe.Names())
	rt.Tracer = (*bridgeTracer)(br)
	rt.DrainUserInput = br.drainPending
	if resume != "" {
		h, err := session.LoadHistory(wd, resume)
		if err != nil {
			return nil, fmt.Errorf("resume: %w", err)
		}
		br.history = h
		br.persisted = len(h)
	}
	return br, nil
}

func (br *bridgeRuntime) runTurn(text string) {
	ctx, cancel := context.WithCancel(context.Background())
	br.setRunning(cancel)
	go func() {
		defer br.setIdle()
		res, err := br.rt.Run(ctx, runtime.RunInput{
			SystemPrompt: br.systemPrompt,
			UserInput:    text,
			History:      br.history,
		})
		if err != nil {
			br.emitError(err)
			br.emit(bridgeEvent{Type: "status", Status: "error", Activity: "Error"})
			br.emit(bridgeEvent{Type: "done"})
			return
		}
		br.history = res.Messages
		if br.persisted < len(br.history) {
			_ = br.session.AppendMessages(br.history[br.persisted:])
			br.persisted = len(br.history)
		}
		_ = br.session.WriteSummary(res.FinishSummary, res.FinishArtifacts, res.Finished)
		br.emit(bridgeEvent{Type: "status", Status: "ready", Activity: "Ready"})
		br.emit(bridgeEvent{Type: "done"})
		if next := br.takePendingJoined(); next != "" {
			br.runTurn(next)
		}
	}()
}

func (br *bridgeRuntime) emit(ev bridgeEvent) {
	br.outMu.Lock()
	defer br.outMu.Unlock()
	_ = br.out.Encode(ev)
}

func (br *bridgeRuntime) emitError(err error) {
	br.emit(bridgeEvent{Type: "append", Kind: "error", Text: err.Error(), Error: err.Error()})
}

func (br *bridgeRuntime) rebuildToolsEnv(outputDir string) {
	reg := tools.NewRegistry()
	tools.RegisterAll(reg, &tools.Env{
		Workdir:    br.wd,
		Project:    br.project,
		SessionDir: br.session.Dir,
		OutputDir:  outputDir,
		Compiler:   &skillplus.Compiler{},
		ImageGen:   br.imgGen,
		Approve: func(req tools.ApprovalRequest) tools.ApprovalDecision {
			return br.requestApproval(req)
		},
		JudgeBash: tools.JudgeBashWithLLM(br.rt.LLM),
		IsBashAllowed: func(binary string) bool {
			return br.allowedBins[binary]
		},
		AllowBash: func(binary string) {
			br.allowedBins[binary] = true
		},
		BashMode: string(br.project.Settings.EffectiveBashMode()),
		Hooks:    br.rt.Hooks,
	})
	br.rt.Registry = reg
}

func (br *bridgeRuntime) reloadProjectRuntime() error {
	if br.isRunning() {
		return errors.New("cannot reload while a turn is running")
	}
	proj, err := projectx.Load(br.wd)
	if err != nil {
		return err
	}
	llmProvider, llmModel, imageProvider, imageModel := resolveDefaults(proj)
	if llmProvider == "" {
		llmProvider = "auto"
	}
	if imageProvider == "" {
		imageProvider = "openrouter"
	}

	apiKey := ""
	llmBaseURL := ""
	if llmProvider != "auto" {
		resolved := userconfig.ResolveProvider(br.wd, llmProvider)
		apiKey = resolved.APIKey
		llmBaseURL = resolved.BaseURL
	}
	llmClient, err := llm.New(llmProvider, apiKey, llmBaseURL, llmModel)
	if err != nil {
		return err
	}
	tc, ok := llmClient.(llm.ToolCaller)
	if !ok {
		return fmt.Errorf("provider %q does not support tool calls", llmClient.Provider())
	}

	var imgGen imagegen.Generator
	if imageModel != "" {
		imgResolved := userconfig.ResolveProvider(br.wd, imageProvider)
		imgGen, err = imagegen.New(imageProvider, imgResolved.APIKey, imgResolved.BaseURL, imageModel)
		if err != nil {
			br.emit(bridgeEvent{Type: "append", Kind: "error", Text: "image generation disabled: " + err.Error()})
		}
	}

	br.project = proj
	br.imgGen = imgGen
	br.rt.LLM = tc
	br.rt.ReasoningEffort = resolveReasoningEffort(proj, llmClient.Provider(), llmClient.Model())
	br.rebuildToolsEnv(projectx.SessionOutputDir(br.wd, filepath.Base(br.session.Dir)))

	probe := tools.NewRegistry()
	tools.RegisterAll(probe, &tools.Env{
		Workdir:   br.wd,
		Project:   proj,
		OutputDir: projectx.OutputDir(br.wd),
		Compiler:  &skillplus.Compiler{},
		ImageGen:  br.imgGen,
	})
	br.systemPrompt = buildProjectSystemPrompt(proj, probe.Names())
	_ = br.session.SetRuntimeInfo(llmClient.Provider(), llmClient.Model())
	br.emit(bridgeEvent{
		Type:      "ready",
		Status:    "ready",
		Activity:  "Ready",
		SessionID: br.session.ID,
		SessionDir: br.session.Dir,
		Model:     llmClient.Model(),
		Reasoning: br.rt.ReasoningEffort,
		Project:   br.project.ID,
		Provider:  llmClient.Provider(),
	})
	return nil
}

func (br *bridgeRuntime) clearHistory() {
	br.history = nil
	br.persisted = 0
	br.emit(bridgeEvent{Type: "append", Kind: "info", Text: "(history cleared)"})
}

func (br *bridgeRuntime) emitHistory() {
	if len(br.history) == 0 {
		br.emit(bridgeEvent{Type: "append", Kind: "info", Text: "(no conversation history)"})
		return
	}
	lines := make([]string, 0, len(br.history))
	for i, mm := range br.history {
		label := string(mm.Role)
		if len(mm.ToolCalls) > 0 {
			label += " → tool_calls"
		}
		body := strings.ReplaceAll(mm.Content, "\n", " ")
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		lines = append(lines, fmt.Sprintf("  [%d] %s: %s", i, label, body))
	}
	br.emit(bridgeEvent{Type: "append", Kind: "info", Text: strings.Join(lines, "\n")})
}

func (br *bridgeRuntime) saveHistory(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		br.emit(bridgeEvent{Type: "append", Kind: "error", Text: "/save: usage: /save <path>"})
		return
	}
	f, err := os.Create(path)
	if err != nil {
		br.emit(bridgeEvent{Type: "append", Kind: "error", Text: "/save: " + err.Error()})
		return
	}
	enc := json.NewEncoder(f)
	var saveErr error
	for _, mm := range br.history {
		if err := enc.Encode(mm); err != nil {
			saveErr = err
			break
		}
	}
	if err := f.Close(); saveErr == nil {
		saveErr = err
	}
	if saveErr != nil {
		br.emit(bridgeEvent{Type: "append", Kind: "error", Text: "/save: " + saveErr.Error()})
		return
	}
	br.emit(bridgeEvent{Type: "append", Kind: "info", Text: fmt.Sprintf("saved %d messages → %s", len(br.history), path)})
}

func (br *bridgeRuntime) rtModel() string {
	if c, ok := br.rt.LLM.(interface{ Model() string }); ok {
		return c.Model()
	}
	return ""
}

func (br *bridgeRuntime) rtProvider() string {
	if c, ok := br.rt.LLM.(interface{ Provider() string }); ok {
		return c.Provider()
	}
	return ""
}

func (br *bridgeRuntime) addPending(text string) {
	br.pendingMu.Lock()
	defer br.pendingMu.Unlock()
	br.pending = append(br.pending, text)
}

func (br *bridgeRuntime) drainPending() []string {
	br.pendingMu.Lock()
	defer br.pendingMu.Unlock()
	out := append([]string(nil), br.pending...)
	br.pending = nil
	return out
}

func (br *bridgeRuntime) takePendingJoined() string {
	pending := br.drainPending()
	if len(pending) == 0 {
		return ""
	}
	return strings.Join(pending, "\n\n")
}

func (br *bridgeRuntime) setRunning(cancel context.CancelFunc) {
	br.cancelMu.Lock()
	defer br.cancelMu.Unlock()
	br.cancel = cancel
	br.running = true
}

func (br *bridgeRuntime) setIdle() {
	br.cancelMu.Lock()
	defer br.cancelMu.Unlock()
	br.cancel = nil
	br.running = false
}

func (br *bridgeRuntime) isRunning() bool {
	br.cancelMu.Lock()
	defer br.cancelMu.Unlock()
	return br.running
}

func (br *bridgeRuntime) cancelRun() {
	br.cancelMu.Lock()
	cancel := br.cancel
	br.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (br *bridgeRuntime) requestApproval(req tools.ApprovalRequest) tools.ApprovalDecision {
	br.approvalMu.Lock()
	br.approvalSeq++
	id := fmt.Sprintf("approval-%d", br.approvalSeq)
	ch := make(chan tools.ApprovalDecision, 1)
	br.approvals[id] = ch
	br.approvalMu.Unlock()

	br.emit(bridgeEvent{
		Type:     "approval",
		Activity: "Approve " + req.Tool,
		Detail: map[string]any{
			"id":          id,
			"tool":        req.Tool,
			"command":     req.Command,
			"description": req.Description,
			"binary":      req.Binary,
		},
	})

	select {
	case decision := <-ch:
		return decision
	case <-time.After(10 * time.Minute):
		br.answerApproval(id, tools.ApprovalDecision{})
		return tools.ApprovalDecision{}
	}
}

func (br *bridgeRuntime) answerApproval(id string, decision tools.ApprovalDecision) {
	br.approvalMu.Lock()
	ch := br.approvals[id]
	delete(br.approvals, id)
	br.approvalMu.Unlock()
	if ch != nil {
		ch <- decision
	}
}

type bridgeTracer bridgeRuntime

func (t *bridgeTracer) br() *bridgeRuntime { return (*bridgeRuntime)(t) }

func (t *bridgeTracer) OnTurnStart(turn int) {
	t.br().emit(bridgeEvent{Type: "status", Status: "thinking", Activity: fmt.Sprintf("Thinking step %d", turn)})
}

func (t *bridgeTracer) OnText(delta string) {
	t.br().emit(bridgeEvent{Type: "append", Kind: "assistant", Text: delta})
}

func (t *bridgeTracer) OnToolCall(call llm.ToolCall) {
	if call.Name == "finish" {
		return
	}
	t.br().emit(bridgeEvent{
		Type:     "append",
		Kind:     "tool",
		Text:     fmt.Sprintf("● %s  %s", call.Name, strings.TrimSpace(string(call.Arguments))),
		Status:   "tool",
		Activity: "Calling " + call.Name,
	})
	t.br().emit(bridgeEvent{Type: "status", Status: "tool", Activity: "Calling " + call.Name})
}

func (t *bridgeTracer) OnToolResult(call llm.ToolCall, content string, err error) {
	if call.Name == "finish" {
		t.br().emit(bridgeEvent{Type: "append", Kind: "assistant", Text: finishSummary(content)})
		return
	}
	kind := "result"
	text := "└ " + compactToolResult(content)
	if err != nil {
		kind = "error"
		text = "└ error: " + err.Error()
	}
	t.br().emit(bridgeEvent{Type: "append", Kind: kind, Text: text})
}

func (t *bridgeTracer) OnTurnEnd(_ int, _ llm.FinishReason, usage llm.Usage) {
	t.br().emit(bridgeEvent{
		Type:             "usage",
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
	})
}

func compactToolResult(content string) string {
	var obj map[string]any
	if err := json.Unmarshal([]byte(content), &obj); err != nil {
		return truncateBridge(content, 220)
	}
	if raw, ok := obj["error"]; ok {
		return fmt.Sprintf("error: %v", raw)
	}
	for _, key := range []string{"path", "file", "output", "summary", "status"} {
		if v, ok := obj[key]; ok {
			return truncateBridge(fmt.Sprintf("%s: %v", key, v), 220)
		}
	}
	return truncateBridge(content, 220)
}

func finishSummary(content string) string {
	var obj map[string]any
	if err := json.Unmarshal([]byte(content), &obj); err != nil {
		return content
	}
	if s, _ := obj["summary"].(string); strings.TrimSpace(s) != "" {
		return s
	}
	return content
}

func truncateBridge(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
