import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateInstanceModal } from "./CreateInstanceModal";

interface CreateInstanceButtonProps {
  onInstanceCreated: () => void;
}

export function CreateInstanceButton({ onInstanceCreated }: CreateInstanceButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-cc-primary text-white rounded-lg text-sm font-medium hover:bg-cc-primary-hover transition-colors"
      >
        <Plus size={16} />
        Create Instance
      </button>

      {open && (
        <CreateInstanceModal
          onClose={() => setOpen(false)}
          onInstanceCreated={onInstanceCreated}
        />
      )}
    </>
  );
}
