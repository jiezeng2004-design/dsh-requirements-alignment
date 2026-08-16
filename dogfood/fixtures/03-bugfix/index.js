// Mini task app: renders a form and handles submission.
export function handleSubmit(form) {
  // form.email may be undefined when the email field is missing from the DOM;
  // reading .value then throws a TypeError.
  const email = form.email.value.trim();
  const name = form.name.value.trim();
  if (!email || !name) {
    return { ok: false, error: 'Name and email are required.' };
  }
  return { ok: true, task: { name, email } };
}
