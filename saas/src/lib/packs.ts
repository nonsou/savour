// Three editable starter packs (operational aids, not regulatory standards).
import type { AttendanceMode, Criterion } from "./scoring";

export type PackId = "food_vendors" | "restaurant_ops" | "supplier_service";

export interface StarterPack {
  id: PackId;
  name: string;
  subjectLabel: string;
  attendanceMode: AttendanceMode;
  criteria: Criterion[];
  description: string;
}

const c = (key: string, label: string, guidance: string, allow_na = false): Criterion => ({ key, label, guidance, allow_na });

export const STARTER_PACKS: StarterPack[] = [
  {
    id: "food_vendors", name: "Food vendors", subjectLabel: "Vendors", attendanceMode: "scored",
    description: "A panel rates vendors, confirms readiness and attendance, then reviews a session report.",
    criteria: [
      c("taste", "Taste", "Flavour, seasoning and doneness."),
      c("aroma", "Aroma", "Smell is fresh and appetising."),
      c("appearance", "Appearance", "Presentation and portion look right."),
      c("hygiene", "Hygiene", "Handling, gloves, clean utensils."),
      c("environment", "Environment", "Stall and surroundings are clean and tidy."),
      c("storage", "Storage", "Food is covered and held at safe temperatures."),
      c("safety", "Safety", "Gas, fire and physical safety controls.", true),
    ],
  },
  {
    id: "restaurant_ops", name: "Restaurant operations", subjectLabel: "Operations", attendanceMode: "off",
    description: "A named assessor checks an outlet, kitchen or service operation. No arrival is required.",
    criteria: [
      c("hygiene", "Hygiene", "Hand washing, surfaces and pest control."),
      c("storage", "Storage", "Labelling, rotation and temperatures."),
      c("environment", "Environment", "Dining and back-of-house cleanliness."),
      c("safety", "Safety", "Fire, gas, first aid and slip hazards."),
      c("service_quality", "Service quality", "Greeting, timing and accuracy of service.", true),
    ],
  },
  {
    id: "supplier_service", name: "Supplier and service quality", subjectLabel: "Suppliers and services", attendanceMode: "off",
    description: "Staff review delivery or service quality for a named provider.",
    criteria: [
      c("quality", "Quality", "Goods or work meet the agreed specification."),
      c("timeliness", "Timeliness", "Delivered or completed when agreed (1-5, not attendance)."),
      c("completeness", "Completeness", "Quantities and scope are complete."),
      c("communication", "Communication", "Clear, timely updates and documents.", true),
      c("issue_resolution", "Issue resolution", "Problems are acknowledged and fixed.", true),
    ],
  },
];

export const packById = (id: string) => STARTER_PACKS.find((p) => p.id === id);
