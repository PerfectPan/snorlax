/**
 * Deletes the device token from the keychain.
 *
 * Pairing does not exist in this build, so there is no item to delete. Batch 7 replaces the body
 * with the `security` / `secret-tool` delete. `uninstall --data` is the only caller.
 */
export function removeKeychainItem(): Promise<void> {
  return Promise.resolve();
}
