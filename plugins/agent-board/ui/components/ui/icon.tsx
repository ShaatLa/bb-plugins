import {
  experimental_Icon as BbIcon,
  type ExperimentalIconProps,
} from "@get-bb/plugin-sdk/app";

export type IconName = string;
export type IconProps = ExperimentalIconProps;
export function Icon({ name, fallback, ...props }: IconProps) {
  if (name === "User" || name === "Archive") {
    return (
      <svg
        aria-hidden="true"
        {...props}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {name === "User" ? (
          <>
            <circle cx="12" cy="7" r="4" />
            <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
          </>
        ) : (
          <>
            <rect x="3" y="3" width="18" height="4" rx="1" />
            <path d="M5 7v14h14V7M10 12h4" />
          </>
        )}
      </svg>
    );
  }
  return <BbIcon name={name} fallback={fallback} {...props} />;
}
