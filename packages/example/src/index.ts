export interface GreetingOptions {
  punctuation?: string;
}

export function greet(name: string, options: GreetingOptions = {}): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TypeError("name must not be empty");
  }
  return `Hello, ${trimmed}${options.punctuation ?? "!"}`;
}
