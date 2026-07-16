#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Fourbuy Car Buying Co. — Admin Detail View Overhaul (P0) + Dealer Profile/Cover Photos (P1).
  The admin detail view (both mobile screen and desktop cockpit) must display all new
  progressive-submission fields, a large hero "Overall Condition" average rating, and a
  fullscreen swipeable photo carousel. Admins must be able to upload/replace a dealer's
  Profile Picture and Cover Photo (WhatsApp-Business style), and dealers must see them
  read-only on their profile screen. Strict monochrome (black/white/grey) with UPPERCASE
  headings — no colour introduction.

backend:
  - task: "Add dealer photo fields + admin photo upload endpoint"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added Pydantic model DealerPhotoUpload with optional profile_pic/cover_photo
          (base64 data URLs; empty string clears). New admin routes:
            POST /api/admin/dealers/{id}/photos  (admin only)
            GET  /api/admin/dealers/{id}         (admin only)
          Updated /api/auth/login response to include profile_pic and cover_photo so the
          dealer's own profile screen can render them. /api/auth/me already returns the
          full user document. Existing /api/admin/dealers list includes photos (no
          projection filter). Cannot lose data — photos are stored under user doc.

frontend:
  - task: "Admin mobile vehicle detail view — new fields, avg rating hero, fullscreen carousel"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(app)/vehicle/[id].tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Full rewrite:
            • Added hero card computing (exterior + interior + tyres)/3 → shows big
              X.X / 10 + progress bar + 3 breakdown pills.
            • Extended Submission type: fuel_type, transmission, year_of_production,
              year_registered, exterior/interior/tyre/windscreen condition, service
              history, paint_evidence, reconditioning_items, VIN, engine_number.
            • New sections rendered: Vehicle Specs, Condition, Service History,
              Reconditioning Estimate, Identity.
            • Photos: 5-slot grid with correct keys (front/driver_side/passenger_side/
              rear/interior) + fallback to legacy side_right/side_left. Tapping a photo
              opens PhotoCarousel (fullscreen swipe modal).
            • Kept AI Market Analysis + License Disk decoded rows.
            • Monochrome theme preserved; danger red only for Accident/Paint Yes.

  - task: "Desktop cockpit detail view — hero rating, new sections, tap-to-expand carousel"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/WebAdminDashboard.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Extended SubmissionFull type with all new fields. Added memoised averageRating
          + carouselPhotos. Detail column now renders: Hero condition card (big number
          on the left, 3 pills on the right), Vehicle Specs, Condition, Service History,
          Reconditioning, Identity, Photos (tap thumbnail → PhotoCarousel), then existing
          AI Market Analysis and pricing. Photo keys fixed to match backend submissions.

  - task: "Reusable fullscreen PhotoCarousel modal"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/PhotoCarousel.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          New component. Modal with horizontal ScrollView pagingEnabled for swipe;
          desktop shows chevron prev/next arrows. Thumbnail strip + dots at bottom.
          Counter (idx/total) + slot label in top bar. Tap outside image closes.
          Opens instantly to the initialIndex the user tapped.

  - task: "Admin dealer photo upload modal + Photos action button"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/DealerPhotosModal.tsx, /app/frontend/app/(app)/dealers.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          DealerPhotosModal lets admin pick from library (base64 quality 0.6, aspect
          1:1 for profile, 16:9 for cover), preview live in WhatsApp Business layout,
          and clear/replace. Save button only sends changed fields to
          POST /api/admin/dealers/{id}/photos. Dealer row avatar now renders profile_pic
          if uploaded; new "Photos" button next to Edit/Reset PW opens the modal.

  - task: "Dealer profile screen — WhatsApp Business-style banner"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(app)/profile.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Redesigned Profile screen: 160h banner shows cover_photo (or dashed
          placeholder), with a 100px round profile_pic overlapping the bottom-left in
          WhatsApp Business style. Below: name, email, role, company details. Hint
          card informs dealer photos are managed by Fourbuy (read-only) when neither
          is set. Extended User type in AuthContext with profile_pic + cover_photo.

  - task: "Dealers management inside web admin cockpit"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/WebAdminDashboard.tsx, /app/frontend/app/(app)/dealers.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added a third top-nav tab "DEALERS" (testID cockpit-view-dealers) beside
          Submissions and Billing in the web cockpit. Selecting it renders the existing
          DealersScreen inline. DealersScreen uses BottomTabBarHeightContext via
          useContext (safe fallback = 0) so it no longer crashes when rendered outside
          a bottom-tab navigator. All existing dealer actions (Edit, Photos, Reset PW,
          Archive/Restore, Active toggle, Add Dealer) work in the web cockpit.

  - task: "Vertical spec list + softer typography on detail views"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(app)/vehicle/[id].tsx, /app/frontend/src/components/WebAdminDashboard.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Rewrote both mobile /vehicle/[id] and desktop cockpit detail column to
          use a vertical "Label: value" list (DetailRow helper) for Vehicle Details,
          Condition, Service History, Reconditioning and Identity. New layout order
          exactly matches user spec: Year Registered / Make / Model / Derivative /
          Mileage / Transmission / Fuel Type / Colour / Year of Production.
          Softened typography app-wide: removed textTransform:"uppercase" and heavy
          letterSpacing (2+) from headings/titles/labels; bumped font sizes 1-2px
          for legibility. Reference numbers now show at 14-16px in white mono.
          Also updated the dealer dashboard cards, profile screen and cockpit list
          row typography for consistency. Added a `type` scale in theme.ts for
          future consistency.

metadata:
  created_by: "main_agent"
  version: "1.2"
  test_sequence: 12
  run_ui: true

test_plan:
  current_focus:
    - "Dealers management inside web admin cockpit"
    - "Vertical spec list + softer typography on detail views"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Round of admin-panel/dealer-photos work complete. Backend + frontend both changed.
      Backend added: DealerPhotoUpload model, POST /api/admin/dealers/{id}/photos and
      GET /api/admin/dealers/{id}. /api/auth/login response now includes profile_pic +
      cover_photo. Frontend: new PhotoCarousel (fullscreen swipe modal),
      DealerPhotosModal (admin upload), rewritten vehicle/[id].tsx and updated
      WebAdminDashboard detail column with hero average condition + new sections,
      redesigned profile.tsx banner.
  - agent: "testing"
    message: |
      Iteration 12 regression: all focus tasks PASS. Cockpit shows Dealers tab and
      renders the DealersScreen inline without hook crashes. Vertical DetailRow list
      renders in the exact spec order on both mobile and desktop. Typography softened
      as expected. Backend dealer-photos suite still 22/22 green. Note: legacy seeds
      FB-000001/FB-000002 predate the new schema fields (fuel/transmission/exterior
      etc.) so those rows show em-dash — not a code regression. React-native-web
      shadow* deprecation warnings still present but harmless.

