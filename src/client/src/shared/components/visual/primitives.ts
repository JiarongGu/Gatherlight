// L1 — the in-house surface over antd primitives. L2/L3 import these from
// `@/shared/components/visual`, never `antd` directly, so the underlying UI kit
// is swappable and the dependency is centralized here.
export {
  Button,
  Input,
  Tag,
  Alert,
  Tooltip,
  Modal,
  Drawer,
  Switch,
  Spin,
  Dropdown,
  Menu,
  Image,
  Empty,
  Collapse,
  Space,
  App,
  Card,
  Typography,
  type MenuProps
} from 'antd';
