/**
 * preview/js/main.js — единственная точка входа для скриптов прототипа.
 * Подгружаются ES-модулями (defer-эквивалент), порядок отражает
 * зависимости: сначала тема и навигация, потом — фичи.
 */

import "./modules/theme.js";
import "./modules/brand.js";
import "./modules/dropdown.js";
import "./modules/nav.js";
import "./modules/home.js";
import "./modules/email.js";
import "./modules/mailer.js";

// сервисы и общие обработчики — после остальных, чтобы DOM уже был размечен
import "./modules/toast.js";
import "./modules/actions.js";
import "./modules/bulk-dd.js";
import "./modules/chart.js";
