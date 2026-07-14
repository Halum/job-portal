/** Replaces `{{name}}` placeholders with `vars[name]`. Unknown placeholders
 * resolve to '' rather than being left as literal `{{x}}` in the rendered
 * prompt (PRD §11 step 3). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*}}/g, (_match, name: string) => vars[name] ?? '');
}
