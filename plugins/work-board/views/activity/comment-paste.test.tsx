// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentComposer } from "./task-activity.js";

const { rpcCall, uploadAttachment } = vi.hoisted(() => ({
  rpcCall: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock("../../shell/data.js", () => ({
  useMentionItems: () => async () => [],
  useTasksRpc: () => ({ call: rpcCall }),
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  useBbNavigate: () => ({ toThread: vi.fn() }),
}));

vi.mock("../detail/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../detail/attachments.js")>()),
  uploadAttachment,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("pastes an image into a comment and uploads it under the new comment", async () => {
  rpcCall.mockResolvedValue({ comment: { id: "comment_paste" } });
  uploadAttachment.mockResolvedValue({ attachmentId: "image_paste", url: "/image" });
  const view = render(
    <CommentComposer taskId="task_paste" notificationTarget={{ kind: "none" }} />,
  );
  const image = new File(["png"], "screenshot.png", { type: "image/png" });
  const surface = view.container.querySelector(".tiptap")!;
  fireEvent.paste(surface, {
    clipboardData: { files: [image], getData: () => "" },
  });

  expect(view.getByText("screenshot.png")).toBeTruthy();
  expect(uploadAttachment).not.toHaveBeenCalled();
  const submit = view.getByRole("button", { name: "Comment" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);

  await waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith(image, {
    commentId: "comment_paste",
  }));
  expect(rpcCall).toHaveBeenCalledWith("createComment", {
    taskId: "task_paste", body: "", notify: false, allowEmptyBody: true,
  });
  await waitFor(() => expect(view.queryByText("screenshot.png")).toBeNull());
});
