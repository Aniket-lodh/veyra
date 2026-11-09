package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"strings"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	gomail "github.com/wneessen/go-mail"
)

const (
	sendEmailMaxRecipients = 50
	sendEmailMaxBodyBytes  = 256 * 1024
)

// SMTPConfig is worker-side SMTP credentials. Never taken from job payload.
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string // default From when payload omits it
	// TLS: "starttls" (default), "tls" (implicit SSL on connect), "none" (dev only).
	TLS string
}

// Configured reports whether enough config exists to attempt a send.
func (c SMTPConfig) Configured() bool {
	return strings.TrimSpace(c.Host) != ""
}

// MailSender is the single network boundary for send_email.
type MailSender interface {
	Send(ctx context.Context, msg *gomail.Msg) error
}

// SendEmail delivers one outbound email described by the job payload over SMTP.
type SendEmail struct {
	cfg    SMTPConfig
	sender MailSender
}

// NewSendEmail builds the handler.
func NewSendEmail(cfg SMTPConfig) *SendEmail {
	cfg.TLS = normalizeSMTPTLS(cfg.TLS)
	if cfg.Port <= 0 {
		cfg.Port = 587
	}
	return &SendEmail{cfg: cfg, sender: newGoMailSender(cfg)}
}

// NewSendEmailWithSender is for tests — inject a MailSender without dialing.
func NewSendEmailWithSender(cfg SMTPConfig, sender MailSender) *SendEmail {
	cfg.TLS = normalizeSMTPTLS(cfg.TLS)
	if cfg.Port <= 0 {
		cfg.Port = 587
	}
	return &SendEmail{cfg: cfg, sender: sender}
}

type sendEmailPayload struct {
	To      json.RawMessage   `json:"to"`
	From    string            `json:"from"`
	Subject string            `json:"subject"`
	Text    string            `json:"text"`
	HTML    string            `json:"html"`
	CC      json.RawMessage   `json:"cc"`
	BCC     json.RawMessage   `json:"bcc"`
	ReplyTo string            `json:"replyTo"`
	Headers map[string]string `json:"headers"`
}

type parsedEmail struct {
	To      []string
	From    string
	Subject string
	Text    string
	HTML    string
	CC      []string
	BCC     []string
	ReplyTo string
	Headers map[string]string
}

type sendEmailResult struct {
	MessageID  string   `json:"messageId"`
	To         []string `json:"to"`
	DurationMs int64    `json:"durationMs"`
}

func (h *SendEmail) Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error) {
	parsed, err := parseSendEmailPayload(job.Payload, h.cfg.From)
	if err != nil {
		return nil, permanentError("invalid_payload", err.Error())
	}

	if !h.cfg.Configured() {
		return nil, permanentError("smtp_config", "SMTP is not configured on this worker (set VEYRA_SMTP_HOST)")
	}
	if h.sender == nil {
		return nil, permanentError("smtp_config", "SMTP sender is not available")
	}

	msg, messageID, err := buildMailMessage(job.ID, parsed)
	if err != nil {
		return nil, permanentError("invalid_payload", err.Error())
	}

	start := time.Now()
	sendErr := h.sender.Send(ctx, msg)
	elapsed := time.Since(start)

	if sendErr != nil {
		if errors.Is(sendErr, context.Canceled) || errors.Is(sendErr, context.DeadlineExceeded) {
			// Lease loss / shutdown / our deadline — runtime owns reclaim path when jobCtx is cancelled; DeadlineExceeded from SMTP dial maps to timeout.
			if errors.Is(sendErr, context.Canceled) {
				return nil, sendErr
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, &Error{
				Class:   "timeout",
				Message: fmt.Sprintf("smtp send timed out after %dms", elapsed.Milliseconds()),
			}
		}
		return nil, classifySMTPError(sendErr, elapsed)
	}

	raw, err := json.Marshal(sendEmailResult{
		MessageID:  messageID,
		To:         parsed.To,
		DurationMs: elapsed.Milliseconds(),
	})
	if err != nil {
		return nil, fmt.Errorf("send_email: marshal result: %w", err)
	}
	return raw, nil
}

func parseSendEmailPayload(raw json.RawMessage, defaultFrom string) (*parsedEmail, error) {
	var p sendEmailPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("cannot decode send_email payload: %v", err)
	}

	to, err := parseAddressList(p.To, "to")
	if err != nil {
		return nil, err
	}
	if len(to) == 0 {
		return nil, errors.New("send_email payload missing required field: to")
	}

	cc, err := parseAddressList(p.CC, "cc")
	if err != nil {
		return nil, err
	}
	bcc, err := parseAddressList(p.BCC, "bcc")
	if err != nil {
		return nil, err
	}

	total := len(to) + len(cc) + len(bcc)
	if total > sendEmailMaxRecipients {
		return nil, fmt.Errorf("too many recipients (%d); max is %d", total, sendEmailMaxRecipients)
	}

	subject := strings.TrimSpace(p.Subject)
	if subject == "" {
		return nil, errors.New("send_email payload missing required field: subject")
	}

	text := p.Text
	html := p.HTML
	if strings.TrimSpace(text) == "" && strings.TrimSpace(html) == "" {
		return nil, errors.New("send_email payload requires text and/or html body")
	}
	if len(text)+len(html) > sendEmailMaxBodyBytes {
		return nil, fmt.Errorf("body exceeds %d bytes", sendEmailMaxBodyBytes)
	}

	from := strings.TrimSpace(p.From)
	if from == "" {
		from = strings.TrimSpace(defaultFrom)
	}
	if from == "" {
		return nil, errors.New("send_email requires from (payload.from or VEYRA_SMTP_FROM)")
	}
	if _, err := mail.ParseAddress(from); err != nil {
		return nil, fmt.Errorf("invalid from address: %v", err)
	}

	for _, list := range []struct {
		name  string
		addrs []string
	}{
		{"to", to}, {"cc", cc}, {"bcc", bcc},
	} {
		for _, a := range list.addrs {
			if _, err := mail.ParseAddress(a); err != nil {
				return nil, fmt.Errorf("invalid %s address %q: %v", list.name, a, err)
			}
		}
	}

	replyTo := strings.TrimSpace(p.ReplyTo)
	if replyTo != "" {
		if _, err := mail.ParseAddress(replyTo); err != nil {
			return nil, fmt.Errorf("invalid replyTo address: %v", err)
		}
	}

	return &parsedEmail{
		To:      to,
		From:    from,
		Subject: subject,
		Text:    text,
		HTML:    html,
		CC:      cc,
		BCC:     bcc,
		ReplyTo: replyTo,
		Headers: p.Headers,
	}, nil
}

// parseAddressList accepts a JSON string, array of strings, null, or omitted.
func parseAddressList(raw json.RawMessage, field string) ([]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		single = strings.TrimSpace(single)
		if single == "" {
			return nil, nil
		}
		return []string{single}, nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil, fmt.Errorf("%s must be a string or array of strings", field)
	}
	out := make([]string, 0, len(many))
	for _, a := range many {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		out = append(out, a)
	}
	return out, nil
}

func buildMailMessage(jobID string, p *parsedEmail) (*gomail.Msg, string, error) {
	msg := gomail.NewMsg()
	if err := msg.From(p.From); err != nil {
		return nil, "", fmt.Errorf("from: %w", err)
	}
	if err := msg.To(p.To...); err != nil {
		return nil, "", fmt.Errorf("to: %w", err)
	}
	if len(p.CC) > 0 {
		if err := msg.Cc(p.CC...); err != nil {
			return nil, "", fmt.Errorf("cc: %w", err)
		}
	}
	if len(p.BCC) > 0 {
		if err := msg.Bcc(p.BCC...); err != nil {
			return nil, "", fmt.Errorf("bcc: %w", err)
		}
	}
	if p.ReplyTo != "" {
		if err := msg.ReplyTo(p.ReplyTo); err != nil {
			return nil, "", fmt.Errorf("replyTo: %w", err)
		}
	}
	msg.Subject(p.Subject)

	switch {
	case p.Text != "" && p.HTML != "":
		msg.SetBodyString(gomail.TypeTextPlain, p.Text)
		msg.AddAlternativeString(gomail.TypeTextHTML, p.HTML)
	case p.HTML != "":
		msg.SetBodyString(gomail.TypeTextHTML, p.HTML)
	default:
		msg.SetBodyString(gomail.TypeTextPlain, p.Text)
	}

	messageID := fmt.Sprintf("%s@veyra", jobID)
	callerSetMessageID := false
	for k, v := range p.Headers {
		if strings.EqualFold(k, "Message-ID") || strings.EqualFold(k, "Message-Id") {
			callerSetMessageID = true
			messageID = strings.Trim(v, "<>")
			msg.SetMessageIDWithValue(messageID)
			continue
		}
		msg.SetGenHeader(gomail.Header(k), v)
	}
	if !callerSetMessageID {
		msg.SetMessageIDWithValue(messageID)
	}

	return msg, messageID, nil
}

func classifySMTPError(err error, elapsed time.Duration) *Error {
	var sendErr *gomail.SendError
	if errors.As(err, &sendErr) {
		code := sendErr.ErrorCode()
		msg := fmt.Sprintf("smtp send failed after %dms: %v", elapsed.Milliseconds(), err)
		if code == 535 || strings.Contains(strings.ToLower(err.Error()), "auth") {
			return permanentError("smtp_auth", msg)
		}
		if sendErr.IsTemp() || (code >= 400 && code < 500) {
			return &Error{Class: "smtp_4xx", Message: msg}
		}
		if code >= 500 {
			return permanentError("smtp_reject", msg)
		}
		if sendErr.IsTemp() {
			return &Error{Class: "smtp_4xx", Message: msg}
		}
		return permanentError("smtp_reject", msg)
	}

	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return &Error{Class: "connection", Message: fmt.Sprintf("smtp DNS lookup failed after %dms: %s", elapsed.Milliseconds(), dnsErr.Err)}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &Error{Class: "timeout", Message: fmt.Sprintf("smtp network timeout after %dms", elapsed.Milliseconds())}
	}
	return &Error{Class: "connection", Message: fmt.Sprintf("smtp send failed after %dms: %v", elapsed.Milliseconds(), err)}
}

func normalizeSMTPTLS(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "starttls":
		return "starttls"
	case "tls", "ssl":
		return "tls"
	case "none", "off", "disable", "disabled":
		return "none"
	default:
		return "starttls"
	}
}

// goMailSender wraps go-mail Client. One production MailSender impl.
type goMailSender struct {
	client *gomail.Client
}

func newGoMailSender(cfg SMTPConfig) MailSender {
	if !cfg.Configured() {
		return nil
	}
	opts := []gomail.Option{
		gomail.WithPort(cfg.Port),
	}
	switch cfg.TLS {
	case "tls":
		opts = append(opts, gomail.WithSSL())
	case "none":
		opts = append(opts, gomail.WithTLSPolicy(gomail.NoTLS))
	default:
		opts = append(opts, gomail.WithTLSPolicy(gomail.TLSMandatory))
	}
	if cfg.Username != "" {
		opts = append(opts,
			gomail.WithSMTPAuth(gomail.SMTPAuthPlain),
			gomail.WithUsername(cfg.Username),
			gomail.WithPassword(cfg.Password),
		)
	}
	client, err := gomail.NewClient(cfg.Host, opts...)
	if err != nil {
		// Surface at send time as smtp_config via a stub that always fails.
		return &brokenMailSender{err: err}
	}
	return &goMailSender{client: client}
}

func (s *goMailSender) Send(ctx context.Context, msg *gomail.Msg) error {
	return s.client.DialAndSendWithContext(ctx, msg)
}

type brokenMailSender struct{ err error }

func (b *brokenMailSender) Send(context.Context, *gomail.Msg) error {
	return permanentError("smtp_config", fmt.Sprintf("cannot build SMTP client: %v", b.err))
}
