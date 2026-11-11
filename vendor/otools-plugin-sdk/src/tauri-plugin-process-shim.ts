export async function relaunch() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
